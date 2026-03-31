require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const expressLayouts = require('express-ejs-layouts');
const { BlobServiceClient } = require('@azure/storage-blob');
const { TableServiceClient, TableClient, AzureSASCredential } = require('@azure/data-tables');
const { v4: uuidv4 } = require('uuid');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Configurações
app.set('view engine', 'ejs');
app.use(expressLayouts);
app.set('layout', 'layout');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Em produção use true (https)
}));

app.use((req, res, next) => {
    res.locals.currentPath = req.path;
    res.locals.notice = req.query.notice || '';
    res.locals.noticeType = req.query.type || 'success';
    next();
});

// --- Configuração Azure ---
const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const sasToken = process.env.AZURE_SAS_TOKEN;
const containerName = process.env.AZURE_CONTAINER_NAME;
const tableNames = {
    products: process.env.AZURE_TABLE_PRODUCTS,
    customers: process.env.AZURE_TABLE_CUSTOMERS,
    orders: process.env.AZURE_TABLE_ORDERS
};

// Clientes Azure
const blobServiceClient = new BlobServiceClient(`https://${accountName}.blob.core.windows.net?${sasToken}`);
const tableServiceClient = new TableServiceClient(`https://${accountName}.table.core.windows.net`, new AzureSASCredential(sasToken));

// Funções auxiliares Table Storage
const getTableClient = (tableName) => {
    return new TableClient(`https://${accountName}.table.core.windows.net`, tableName, new AzureSASCredential(sasToken));
};

// Inicialização de Tabelas e Dados de Exemplo
async function initializeResources() {
    // Criar tabelas se não existirem
    for (const key in tableNames) {
        try {
            await tableServiceClient.createTable(tableNames[key]);
            console.log(`Tabela ${tableNames[key]} criada ou já existente.`);
        } catch (e) { /* Ignora erro se já existir */ }
    }

    // Criar Container Blob se não existir
    const containerClient = blobServiceClient.getContainerClient(containerName);
    try {
        await containerClient.create();
    } catch (e) { /* Ignora se existir */ }

    // Inserir dados de exemplo se a tabela de produtos estiver vazia
    /*
    const productClient = getTableClient(tableNames.products);
    let productsExist = false;
    for await (const entity of productClient.listEntities()) { productsExist = true; break; }

    if (!productsExist) {
        console.log("Inserindo dados de exemplo...");
        const sampleProducts = [
            { partitionKey: "Eletrônicos", rowKey: uuidv4(), nome: "Smartphone X", descricao: "Celular topo de linha", marca: "TechBrand", modelo: "X-100", preco: 3500.00, quantidade: 10, imageUrl: "https://via.placeholder.com/150" },
            { partitionKey: "Eletrônicos", rowKey: uuidv4(), nome: "Notebook Pro", descricao: "Notebook para trabalho", marca: "TechBrand", modelo: "NP-15", preco: 5000.00, quantidade: 5, imageUrl: "https://via.placeholder.com/150" },
            { partitionKey: "Casa", rowKey: uuidv4(), nome: "Cadeira Gamer", descricao: "Ergonômica e confortável", marca: "Conforto", modelo: "CG-01", preco: 1200.00, quantidade: 20, imageUrl: "https://via.placeholder.com/150" }
        ];
        
        for (const p of sampleProducts) {
            await productClient.createEntity(p);
        }
    }
    */
}

initializeResources().catch(console.error);

// --- ROTAS ---

// Middleware para carrinho na sessão
app.use((req, res, next) => {
    if (!req.session.cart) req.session.cart = [];
    next();
});

// 1. Tela Principal (Listagem)
app.get('/', async (req, res) => {
    const client = getTableClient(tableNames.products);
    const products = [];
    const search = req.query.search || '';
    const marca = req.query.marca || '';
    const minPrice = parseFloat(req.query.minPrice) || 0;
    const maxPrice = parseFloat(req.query.maxPrice) || Infinity;

    // Table Storage não suporta queries complexas de texto ou múltiplos filtros OR facilmente.
    // Estratégia: Buscar tudo (ou por PartitionKey) e filtrar em memória para este exemplo.
    // Em produção, usar Azure Cognitive Search ou SQL.
    const iterator = client.listEntities();
    for await (const entity of iterator) {
        // Filtros manuais
        const matchSearch = entity.nome.toLowerCase().includes(search.toLowerCase()) || entity.descricao.toLowerCase().includes(search.toLowerCase());
        const matchMarca = marca ? entity.marca === marca : true;
        const matchPrice = entity.preco >= minPrice && entity.preco <= maxPrice;

        if (matchSearch && matchMarca && matchPrice) {
            products.push(entity);
        }
    }
    
    res.render('index', { products, query: req.query });
});

// Adicionar ao carrinho
app.post('/cart/add', async (req, res) => {
    const { productId, partitionKey } = req.body;
    const client = getTableClient(tableNames.products);
    try {
        const product = await client.getEntity(partitionKey, productId);
        
        // Verifica estoque
        const cartItem = req.session.cart.find(i => i.rowKey === productId);
        const currentQty = cartItem ? cartItem.qty : 0;

        if (currentQty < product.quantidade) {
            if (cartItem) {
                cartItem.qty++;
            } else {
                req.session.cart.push({
                    rowKey: product.rowKey,
                    partitionKey: product.partitionKey,
                    nome: product.nome,
                    preco: product.preco,
                    qty: 1,
                    maxQty: product.quantidade
                });
            }
        }
        res.redirect('/cart');
    } catch (e) {
        res.status(404).send("Produto não encontrado");
    }
});

// 2. Tela Carrinho
app.get('/cart', (req, res) => {
    const cart = req.session.cart;
    const total = cart.reduce((sum, item) => sum + (item.preco * item.qty), 0);
    res.render('cart', { cart, total });
});

app.post('/cart/update', (req, res) => {
    const { productId, action } = req.body;
    const item = req.session.cart.find(i => i.rowKey === productId);
    if (item) {
        if (action === 'inc' && item.qty < item.maxQty) item.qty++;
        if (action === 'dec' && item.qty > 1) item.qty--;
    }
    res.redirect('/cart');
});

app.post('/checkout', async (req, res) => {
    const { deliveryMethod, paymentMethod, customerEmail } = req.body;
    const cart = req.session.cart;
    
    if (!cart.length) return res.redirect('/');

    // Simulação de criação de pedido no Table Storage
    const orderClient = getTableClient(tableNames.orders);
    const orderId = uuidv4();
    const total = cart.reduce((sum, item) => sum + (item.preco * item.qty), 0);

    const orderEntity = {
        partitionKey: customerEmail || "cliente_anonimo",
        rowKey: orderId,
        date: new Date().toISOString(),
        items: JSON.stringify(cart),
        total: total,
        delivery: deliveryMethod,
        payment: paymentMethod,
        status: "Processando"
    };

    await orderClient.createEntity(orderEntity);

    // Atualizar estoque (simplificado)
    const productClient = getTableClient(tableNames.products);
    for (const item of cart) {
        const product = await productClient.getEntity(item.partitionKey, item.rowKey);
        product.quantidade -= item.qty;
        await productClient.updateEntity(product, "Replace");
    }

    req.session.cart = [];
    res.redirect('/profile?email=' + orderEntity.partitionKey);
});

// 3. Perfil do Cliente
app.get('/profile', async (req, res) => {
    const email = req.query.email;
    const orderClient = getTableClient(tableNames.orders);
    const orders = [];
    
    if (email) {
        // Busca pedidos por PartitionKey (Email)
        try {
            const iterator = orderClient.listEntities({
                queryOptions: { filter: `PartitionKey eq '${email}'` }
            });
            for await (const entity of iterator) {
                orders.push(entity);
            }
        } catch(e) { console.error(e); }
    }
    
    res.render('profile', { orders, email });
});

// 4. Gerenciamento de Produtos (Admin)
app.get('/admin/products', async (req, res) => {
    const client = getTableClient(tableNames.products);
    const products = [];
    for await (const entity of client.listEntities()) products.push(entity);
    res.render('admin/products', { products });
});

app.get('/admin/products/edit', async function adminEditProductHandler(req, res) {
    const productId = req.query.productId;
    const partitionKey = req.query.partitionKey;

    if (!productId || !partitionKey) {
        return res.redirect('/admin/products?type=danger&notice=Produto+invalido+para+edicao');
    }

    const client = getTableClient(tableNames.products);
    try {
        const product = await client.getEntity(partitionKey, productId);
        return res.render('admin/product-edit', { product });
    } catch (e) {
        console.error('Erro ao buscar produto para edição', e);
        return res.redirect('/admin/products?type=danger&notice=Produto+nao+encontrado');
    }
});

app.post('/admin/products/create', upload.single('photo'), async (req, res) => {
    const { nome, descricao, marca, modelo, preco, quantidade } = req.body;
    const client = getTableClient(tableNames.products);
    const containerClient = blobServiceClient.getContainerClient(containerName);
    
    let imageUrl = "https://via.placeholder.com/150"; // Default

    // Upload para Blob Storage
    if (req.file) {
        const blobName = uuidv4() + '-' + req.file.originalname;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.uploadData(req.file.buffer);
        imageUrl = blockBlobClient.url; // URL do blob
    }

    const entity = {
        partitionKey: marca, // Usando Marca como PartitionKey para organização
        rowKey: uuidv4(),
        nome, descricao, marca, modelo, 
        preco: parseFloat(preco), 
        quantidade: parseInt(quantidade),
        imageUrl
    };

    await client.createEntity(entity);
    res.redirect('/admin/products?type=success&notice=Produto+cadastrado+com+sucesso');
});

app.post('/admin/products/update', upload.single('photo'), async (req, res) => {
    const { productId, originalPartitionKey, nome, descricao, marca, modelo, preco, quantidade } = req.body;
    const client = getTableClient(tableNames.products);
    const containerClient = blobServiceClient.getContainerClient(containerName);

    try {
        const existingProduct = await client.getEntity(originalPartitionKey, productId);
        let imageUrl = existingProduct.imageUrl || "https://via.placeholder.com/150";

        if (req.file) {
            const blobName = uuidv4() + '-' + req.file.originalname;
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);
            await blockBlobClient.uploadData(req.file.buffer);
            imageUrl = blockBlobClient.url;
        }

        const updatedEntity = {
            partitionKey: marca,
            rowKey: productId,
            nome,
            descricao,
            marca,
            modelo,
            preco: parseFloat(preco),
            quantidade: parseInt(quantidade, 10),
            imageUrl
        };

        if (originalPartitionKey !== marca) {
            await client.createEntity(updatedEntity);
            await client.deleteEntity(originalPartitionKey, productId);
        } else {
            await client.updateEntity(updatedEntity, "Replace");
        }

        res.redirect('/admin/products?type=success&notice=Produto+atualizado+com+sucesso');
    } catch (e) {
        res.redirect('/admin/products?type=danger&notice=Falha+ao+atualizar+produto');
    }
});

app.post('/admin/products/delete', async (req, res) => {
    const { productId, partitionKey } = req.body;
    const client = getTableClient(tableNames.products);
    await client.deleteEntity(partitionKey, productId);
    res.redirect('/admin/products?type=success&notice=Produto+excluido+com+sucesso');
});

// 5. Gerenciamento de Clientes (Admin)
app.get('/admin/customers', async (req, res) => {
    const client = getTableClient(tableNames.customers);
    const customers = [];
    // Listar clientes (simplificado)
    for await (const entity of client.listEntities()) customers.push(entity);
    res.render('admin/customers', { customers });
});

app.post('/admin/customers/create', async (req, res) => {
    const { nome, sobrenome, email, endereco, telefone } = req.body;
    const client = getTableClient(tableNames.customers);
    
    const entity = {
        partitionKey: "Clientes",
        rowKey: email, // Email como ID único
        nome,
        sobrenome: sobrenome || '',
        endereco,
        telefone
    };
    try {
        await client.createEntity(entity);
        return res.redirect('/admin/customers?type=success&notice=Cliente+cadastrado+com+sucesso');
    } catch (e) {
        // Erro se email já existir
        return res.redirect('/admin/customers?type=danger&notice=Falha+ao+cadastrar+cliente');
    }
});

app.get('/admin/customers/edit', async (req, res) => {
    const email = req.query.email;
    if (!email) {
        return res.redirect('/admin/customers?type=danger&notice=Cliente+invalido+para+edicao');
    }

    const client = getTableClient(tableNames.customers);
    try {
        const customer = await client.getEntity("Clientes", email);
        return res.render('admin/customer-edit', { customer });
    } catch (e) {
        return res.redirect('/admin/customers?type=danger&notice=Cliente+nao+encontrado');
    }
});

app.post('/admin/customers/update', async (req, res) => {
    const { originalEmail, nome, sobrenome, email, endereco, telefone } = req.body;
    const client = getTableClient(tableNames.customers);

    if (!originalEmail || !email) {
        return res.redirect('/admin/customers?type=danger&notice=Dados+invalidos+para+atualizacao');
    }

    const updatedEntity = {
        partitionKey: "Clientes",
        rowKey: email,
        nome,
        sobrenome: sobrenome || '',
        endereco,
        telefone
    };

    try {
        if (originalEmail !== email) {
            await client.createEntity(updatedEntity);
            await client.deleteEntity("Clientes", originalEmail);
        } else {
            await client.updateEntity(updatedEntity, "Replace");
        }
        return res.redirect('/admin/customers?type=success&notice=Cliente+atualizado+com+sucesso');
    } catch (e) {
        return res.redirect('/admin/customers?type=danger&notice=Falha+ao+atualizar+cliente');
    }
});

app.post('/admin/customers/delete', async (req, res) => {
    const { email } = req.body;
    const client = getTableClient(tableNames.customers);

    if (!email) {
        return res.redirect('/admin/customers?type=danger&notice=Cliente+invalido+para+exclusao');
    }

    try {
        await client.deleteEntity("Clientes", email);
        return res.redirect('/admin/customers?type=success&notice=Cliente+excluido+com+sucesso');
    } catch (e) {
        return res.redirect('/admin/customers?type=danger&notice=Falha+ao+excluir+cliente');
    }
});

// Servidor
app.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on port ${process.env.PORT || 3000}`);
});