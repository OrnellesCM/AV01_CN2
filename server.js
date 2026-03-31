require('dotenv').config();
// Debug: Verifique se as variáveis estão carregando
console.log('Account Name:', process.env.AZURE_STORAGE_ACCOUNT_NAME);
console.log('SAS Key starts with ?:', process.env.AZURE_SAS_KEY ? process.env.AZURE_SAS_KEY.startsWith('?') : false);

if (!process.env.AZURE_STORAGE_ACCOUNT_NAME || !process.env.AZURE_SAS_KEY) {
    console.error("ERRO CRÍTICO: Variáveis de ambiente do Azure não definidas.");
    process.exit(1);
}
const express = require('express');
const session = require('express-session');
const { TableClient, AzureSASCredential } = require('@azure/data-tables');
const { BlobServiceClient } = require('@azure/storage-blob');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();

// Configurações
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false
}));

// Configuração Multer (Armazenamento em memória para upload direto p/ Azure)
const upload = multer({ storage: multer.memoryStorage() });

// --- Conexão Azure ---
const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const sasKey = process.env.AZURE_SAS_KEY;
const credential = new AzureSASCredential(sasKey);

// Table Storage Clients
const productsTable = new TableClient(`https://${accountName}.table.core.windows.net`, 'Products', credential);
const customersTable = new TableClient(`https://${accountName}.table.core.windows.net`, 'Customers', credential);
const ordersTable = new TableClient(`https://${accountName}.table.core.windows.net`, 'Orders', credential);

// Blob Storage Client
const blobServiceClient = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential);
const containerName = "product-images";

// Inicialização de Tabelas e Container
async function initAzure() {
    try {
        await productsTable.createTable();
        await customersTable.createTable();
        await ordersTable.createTable();
        const containerClient = blobServiceClient.getContainerClient(containerName);
        await containerClient.createIfNotExists();
        console.log("Azure Storage inicializado com sucesso.");
    } catch (err) {
        console.log("Erro ao inicializar Azure (pode ser que já existam):", err.message);
    }
}
initAzure();

// --- Middleware de Autenticação ---
const requireLogin = (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    next();
};

const requireAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.isAdmin) return next();
    res.status(403).send('Acesso negado.');
};

// =======================================
// ROTAS PÚBLICAS (LOJA)
// =======================================

// Página Inicial - Listagem de Produtos
app.get('/', async (req, res) => {
    try {
        let filter = "PartitionKey eq 'PRODUCT'";
        const search = req.query.search;
        const brand = req.query.brand;
        
        // Filtros dinâmicos simples (para complexos usar OData gerado)
        if (search) filter += ` and contains(Name, '${search}')`;
        if (brand) filter += ` and Brand eq '${brand}'`;
        
        // Table Storage não suporta faixa de preço nativamente de forma eficiente sem indexes, 
        // faremos filtro básico e refinamos em memória ou OData simples.
        const entities = productsTable.listEntities({ queryOptions: { filter } });
        const products = [];
        for await (const entity of entities) {
            products.push(entity);
        }
        
        res.render('index', { user: req.session.user, products });
    } catch (err) {
        res.send("Erro ao carregar produtos: " + err.message);
    }
});

// Carrinho
app.get('/cart', (req, res) => {
    const cart = req.session.cart || [];
    res.render('cart', { user: req.session.user, cart });
});

app.post('/cart/add', async (req, res) => {
    const { productId } = req.body;
    try {
        const product = await productsTable.getEntity('PRODUCT', productId);
        const cart = req.session.cart || [];
        
        const existingItem = cart.find(item => item.rowKey === productId);
        if (existingItem) {
            existingItem.qty++;
        } else {
            cart.push({ ...product, rowKey: productId, qty: 1 });
        }
        req.session.cart = cart;
        res.redirect('/cart');
    } catch (err) {
        res.send("Produto não encontrado.");
    }
});

// Checkout
app.post('/checkout', requireLogin, async (req, res) => {
    const { deliveryMethod, paymentMethod } = req.body;
    const cart = req.session.cart || [];
    
    if (cart.length === 0) return res.redirect('/');

    // Validação simples de estoque
    for (let item of cart) {
        const prod = await productsTable.getEntity('PRODUCT', item.rowKey);
        if (prod.Quantity < item.qty) {
            return res.send(`Estoque insuficiente para ${prod.Name}`);
        }
    }

    // Criar Pedido
    const orderId = uuidv4();
    const total = cart.reduce((sum, item) => sum + (item.Price * item.qty), 0);
    
    const order = {
        partitionKey: req.session.user.rowKey, // ID Cliente
        rowKey: orderId,
        Items: JSON.stringify(cart),
        Total: total,
        DeliveryMethod: deliveryMethod,
        PaymentMethod: paymentMethod,
        Status: "Processando",
        Date: new Date().toISOString()
    };

    await ordersTable.createEntity(order);

    // Atualizar Estoque
    for (let item of cart) {
        const prod = await productsTable.getEntity('PRODUCT', item.rowKey);
        prod.Quantity -= item.qty;
        await productsTable.updateEntity(prod, "Merge");
    }

    req.session.cart = [];
    res.redirect('/profile');
});

// =======================================
// AUTENTICAÇÃO
// =======================================

app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        // Tenta buscar admin (email fixo para exemplo) ou cliente
        // Para simplificar, assumimos que PartitionKey de cliente é 'CUSTOMER'
        const filter = `PartitionKey eq 'CUSTOMER' and Email eq '${email}'`;
        const entities = customersTable.listEntities({ queryOptions: { filter } });
        
        let user = null;
        for await (const entity of entities) {
            user = entity;
        }

        if (!user) return res.render('login', { error: "Usuário não encontrado" });
        
        const isValid = await bcrypt.compare(password, user.Password);
        if (!isValid) return res.render('login', { error: "Senha inválida" });

        req.session.user = { 
            rowKey: user.rowKey, 
            name: user.Name, 
            email: user.Email, 
            isAdmin: user.IsAdmin || false 
        };
        
        if (user.IsAdmin) return res.redirect('/admin/products');
        res.redirect('/profile');
    } catch (err) {
        res.send("Erro no login: " + err.message);
    }
});

app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', async (req, res) => {
    const { name, email, password, address, phone } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const customerId = uuidv4();

    const customer = {
        partitionKey: 'CUSTOMER',
        rowKey: customerId,
        Name: name,
        Email: email,
        Password: hashedPassword,
        Address: address,
        Phone: phone,
        IsAdmin: false
    };

    try {
        await customersTable.createEntity(customer);
        res.redirect('/login');
    } catch (err) {
        res.send("Erro ao cadastrar: " + err.message);
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Perfil do Cliente
app.get('/profile', requireLogin, async (req, res) => {
    try {
        const filter = `PartitionKey eq '${req.session.user.rowKey}'`;
        const entities = ordersTable.listEntities({ queryOptions: { filter } });
        const orders = [];
        for await (const entity of entities) {
            orders.push(entity);
        }
        res.render('profile', { user: req.session.user, orders });
    } catch (err) {
        res.send("Erro: " + err.message);
    }
});

// =======================================
// PAINEL ADMIN - PRODUTOS
// =======================================

app.get('/admin/products', requireAdmin, async (req, res) => {
    const entities = productsTable.listEntities({ queryOptions: { filter: "PartitionKey eq 'PRODUCT'" } });
    const products = [];
    for await (const entity of entities) products.push(entity);
    res.render('admin/products', { products });
});

app.get('/admin/products/new', requireAdmin, (req, res) => {
    res.render('admin/product-form', { product: {} });
});

app.post('/admin/products/new', requireAdmin, upload.single('photo'), async (req, res) => {
    const { name, description, brand, model, price, quantity } = req.body;
    const productId = uuidv4();
    let imageUrl = '';

    // Upload da Imagem
    if (req.file) {
        const containerClient = blobServiceClient.getContainerClient(containerName);
        const blobName = `${productId}-${req.file.originalname}`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.uploadData(req.file.buffer);
        imageUrl = blockBlobClient.url;
    }

    const product = {
        partitionKey: 'PRODUCT',
        rowKey: productId,
        Name: name,
        Description: description,
        Brand: brand,
        Model: model,
        Price: parseFloat(price),
        Quantity: parseInt(quantity),
        ImageUrl: imageUrl
    };

    await productsTable.createEntity(product);
    res.redirect('/admin/products');
});

app.post('/admin/products/delete/:id', requireAdmin, async (req, res) => {
    await productsTable.deleteEntity('PRODUCT', req.params.id);
    res.redirect('/admin/products');
});

// =======================================
// PAINEL ADMIN - CLIENTES
// =======================================

app.get('/admin/customers', requireAdmin, async (req, res) => {
    const entities = customersTable.listEntities({ queryOptions: { filter: "PartitionKey eq 'CUSTOMER'" } });
    const customers = [];
    for await (const entity of entities) customers.push(entity);
    res.render('admin/customers', { customers });
});

app.get('/admin/customers/orders/:id', requireAdmin, async (req, res) => {
    const customerId = req.params.id;
    const entities = ordersTable.listEntities({ queryOptions: { filter: `PartitionKey eq '${customerId}'` } });
    const orders = [];
    for await (const entity of entities) orders.push(entity);
    res.render('admin/orders', { orders, customerId });
});

// Iniciar Servidor
app.listen(process.env.PORT || 3000, () => {
    console.log(`Servidor rodando na porta ${process.env.PORT || 3000}`);
});