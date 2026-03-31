require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { TableClient } = require("@azure/data-tables");
const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurações
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Configuração Azure
const tableSasUrl = process.env.AZURE_TABLE_SAS_URL;
const blobSasUrl = process.env.AZURE_BLOB_SAS_URL;

const blobServiceClient = new BlobServiceClient(blobSasUrl);
// O Blob Storage ACEITA hífens
const containerName = 'claudio-products-images'; 

// O Table Storage NÃO ACEITA hífens. Usado 'claudio' grudado no nome.
const productsTable = new TableClient(tableSasUrl, 'claudioproducts');
const customersTable = new TableClient(tableSasUrl, 'claudiocustomers');
const ordersTable = new TableClient(tableSasUrl, 'claudioorders');

// Multer (Upload de imagens em memória)
const upload = multer({ storage: multer.memoryStorage() });

// ==========================================
// INICIALIZAÇÃO E SEED (Primeira Execução)
// ==========================================
async function initializeAzure() {
    try {
        // Criar Container de Imagens
        const containerClient = blobServiceClient.getContainerClient(containerName);
        await containerClient.createIfNotExists();
        console.log(`Container '${containerName}' garantido.`);

        // Criar Tabelas (Nomes estritamente alfanuméricos)
        for (const tbl of ['claudioproducts', 'claudiocustomers', 'claudioorders']) {
            const client = new TableClient(tableSasUrl, tbl);
            await client.createTable();
            console.log(`Tabela '${tbl}' garantida.`);
        }

        // Seed: Inserir dados de exemplo se a tabela de produtos estiver vazia
        const products = productsTable.listEntities();
        let hasProducts = false;
        for await (const p of products) { hasProducts = true; break; }

        if (!hasProducts) {
            const sampleProducts = [
                { rowKey: `prod_${uuidv4()}`, nome: 'Notebook Gamer', descricao: 'RTX 4060, 16GB RAM', marca: 'Dell', modelo: 'G15', preco: 7500.00, quantidade: 10, fotoUrl: 'https://via.placeholder.com/300' },
                { rowKey: `prod_${uuidv4()}`, nome: 'Mouse Sem Fio', descricao: 'Ergonômico, 2400DPI', marca: 'Logitech', modelo: 'MX Master', preco: 500.00, quantidade: 25, fotoUrl: 'https://via.placeholder.com/300' }
            ];
            for (const sp of sampleProducts) {
                await productsTable.createEntity({ partitionKey: 'product', ...sp });
            }

            const sampleCustomer = {
                partitionKey: 'customer',
                rowKey: `cust_${uuidv4()}`,
                nome: 'João da Silva',
                cpf: '123.456.789-00',
                email: 'joao@example.com',
                telefone: '11999999999',
                endereco: 'Rua das Flores, 100',
                cidade: 'São Paulo',
                cep: '01000-000'
            };
            await customersTable.createEntity(sampleCustomer);
            console.log('Dados de exemplo inseridos.');
        }
    } catch (err) {
        console.error('Erro na inicialização do Azure:', err.message);
    }
}

// ==========================================
// ROTAS DA LOJA (CLIENTE)
// ==========================================

app.get('/', async (req, res) => {
    const products = [];
    try {
        const entities = productsTable.listEntities({ queryOptions: { filter: "PartitionKey eq 'product'" } });
        for await (const entity of entities) products.push(entity);
    } catch (err) { console.error(err); }
    res.render('index', { products, cart: req.session.cart || [] });
});

app.post('/cart/add/:id', async (req, res) => {
    if (!req.session.cart) req.session.cart = [];
    const product = await productsTable.getEntity('product', req.params.id);
    
    const existingIndex = req.session.cart.findIndex(item => item.rowKey === req.params.id);
    if (existingIndex >= 0) {
        req.session.cart[existingIndex].qty += 1;
    } else {
        req.session.cart.push({ ...product, qty: 1 });
    }
    res.redirect('/');
});

app.get('/cart', (req, res) => {
    const cart = req.session.cart || [];
    res.render('cart', { cart });
});

app.post('/checkout', async (req, res) => {
    const cart = req.session.cart || [];
    if (cart.length === 0) return res.redirect('/cart');
    
    const { tipoEntrega, metodoPagamento } = req.body;
    
    for (const item of cart) {
        if (item.qty > item.quantidade) {
            return res.send(`Erro: Produto ${item.nome} não tem estoque suficiente.`);
        }
    }

    try {
        for (const item of cart) {
            await productsTable.updateEntity({
                partitionKey: 'product',
                rowKey: item.rowKey,
                quantidade: item.quantidade - item.qty
            }, 'Merge');
        }

        const customers = customersTable.listEntities({ queryOptions: { filter: "PartitionKey eq 'customer'" } });
        let custId = 'guest';
        for await (const c of customers) { custId = c.rowKey; break; }

        await ordersTable.createEntity({
            partitionKey: `order_${custId}`,
            rowKey: `order_${uuidv4()}`,
            items: JSON.stringify(cart.map(i => ({ nome: i.nome, qty: i.qty, preco: i.preco }))),
            tipoEntrega,
            metodoPagamento,
            status: 'Confirmado',
            total: cart.reduce((sum, i) => sum + (i.preco * i.qty), 0)
        });

        req.session.cart = [];
        res.redirect('/profile');
    } catch (err) {
        res.status(500).send('Erro ao finalizar pedido: ' + err.message);
    }
});

app.get('/profile', async (req, res) => {
    const customers = customersTable.listEntities({ queryOptions: { filter: "PartitionKey eq 'customer'" } });
    let customer = {};
    for await (const c of customers) { customer = c; break; }

    const orders = [];
    const orderEntities = ordersTable.listEntities({ queryOptions: { filter: `PartitionKey eq 'order_${customer.rowKey}'` } });
    for await (const o of orderEntities) orders.push(o);

    res.render('profile', { customer, orders });
});

app.post('/profile/edit', async (req, res) => {
    const customers = customersTable.listEntities({ queryOptions: { filter: "PartitionKey eq 'customer'" } });
    let customer = {};
    for await (const c of customers) { customer = c; break; }

    await customersTable.updateEntity({
        partitionKey: customer.partitionKey,
        rowKey: customer.rowKey,
        ...req.body,
        cpf: customer.cpf
    }, 'Merge');
    res.redirect('/profile');
});

// ==========================================
// ROTAS ADMIN: PRODUTOS
// ==========================================
app.get('/admin/products', async (req, res) => {
    let products = [];
    const entities = productsTable.listEntities({ queryOptions: { filter: "PartitionKey eq 'product'" } });
    for await (const entity of entities) products.push(entity);

    const { q, marca, modelo, precoMin, precoMax } = req.query;
    if (q) products = products.filter(p => p.nome.toLowerCase().includes(q.toLowerCase()) || p.descricao.toLowerCase().includes(q.toLowerCase()));
    if (marca) products = products.filter(p => p.marca.toLowerCase() === marca.toLowerCase());
    if (modelo) products = products.filter(p => p.modelo.toLowerCase() === modelo.toLowerCase());
    if (precoMin) products = products.filter(p => p.preco >= parseFloat(precoMin));
    if (precoMax) products = products.filter(p => p.preco <= parseFloat(precoMax));

    res.render('admin/products', { products, query: req.query });
});

app.get('/admin/products/new', (req, res) => res.render('admin/product-form', { product: {} }));
app.get('/admin/products/edit/:id', async (req, res) => {
    const product = await productsTable.getEntity('product', req.params.id);
    res.render('admin/product-form', { product });
});

app.post('/admin/products', upload.single('foto'), async (req, res) => {
    let fotoUrl = req.body.fotoUrl || '';
    
    if (req.file) {
        const blobName = `claudio-${uuidv4()}_${req.file.originalname}`;
        const blockBlobClient = blobServiceClient.getContainerClient(containerName).getBlockBlobClient(blobName);
        await blockBlobClient.uploadData(req.file.buffer);
        fotoUrl = blockBlobClient.url;
    }

    const id = req.body.rowKey || `prod_${uuidv4()}`;
    const entity = {
        partitionKey: 'product',
        rowKey: id,
        nome: req.body.nome,
        descricao: req.body.descricao,
        marca: req.body.marca,
        modelo: req.body.modelo,
        preco: parseFloat(req.body.preco),
        quantidade: parseInt(req.body.quantidade),
        fotoUrl: fotoUrl
    };

    if (req.body.rowKey) {
        await productsTable.updateEntity(entity, 'Merge');
    } else {
        await productsTable.createEntity(entity);
    }
    res.redirect('/admin/products');
});

app.post('/admin/products/delete/:id', async (req, res) => {
    await productsTable.deleteEntity('product', req.params.id);
    res.redirect('/admin/products');
});

// ==========================================
// ROTAS ADMIN: CLIENTES
// ==========================================
app.get('/admin/customers', async (req, res) => {
    let customers = [];
    const entities = customersTable.listEntities({ queryOptions: { filter: "PartitionKey eq 'customer'" } });
    for await (const entity of entities) customers.push(entity);
    res.render('admin/customers', { customers });
});

app.get('/admin/customers/:id/orders', async (req, res) => {
    const orders = [];
    const entities = ordersTable.listEntities({ queryOptions: { filter: `PartitionKey eq 'order_${req.params.id}'` } });
    for await (const entity of entities) orders.push(entity);
    res.json(orders);
});

app.post('/admin/customers/delete/:id', async (req, res) => {
    await customersTable.deleteEntity('customer', req.params.id);
    res.redirect('/admin/customers');
});

// Inicialização
initializeAzure().then(() => {
    app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
});