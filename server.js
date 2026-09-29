import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { db } from "./db.js";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import cookieParser from "cookie-parser";

const requiredEnv = [
    "ANTHROPIC_API_KEY",
    "JWT_SECRET",
    "DB_HOST",
    "DB_USER",
    "DB_NAME"
];
for (const name of requiredEnv) {
    if (!process.env[name]) {
        throw new Error(`Отсутствует обязательная переменная окружения: ${name}`);
    }
}

function generateRefreshToken() {
    return crypto.randomBytes(64).toString("hex");
}

function hashRefreshToken(token) {
    return crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
}

async function saveRefreshToken(userId, token) {
    const tokenHash = hashRefreshToken(token);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await db.execute(
        `INSERT INTO refresh_tokens
         (user_id, token_hash, expires_at)
         VALUES (?, ?, ?)`,
        [userId, tokenHash, expiresAt]
    );
}

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});


async function checkStock(productName) {
    const [rows] = await db.execute(
        "SELECT name, stock FROM products WHERE LOWER(name) = LOWER(?) LIMIT 1",
        [productName]
    );

    if (rows.length === 0) {
        return { error: "Товар не найден" };
    }

    return {
        name: rows[0].name,
        stock: rows[0].stock
    };
}

async function getPrice(productName) {
    const [rows] = await db.execute(
        "SELECT name, price, currency FROM products WHERE LOWER(name) = LOWER(?) LIMIT 1",
        [productName]
    );

    if (rows.length === 0) {
        return { error: "Товар не найден" };
    }

    return {
        name: rows[0].name,
        price: Number(rows[0].price),
        currency: rows[0].currency
    };
}
async function searchProducts(query = "", inStockOnly = false, category = "") {
    let search = String(query || "").trim();
    let productCategory = String(category || "").trim();

    const normalizedSearch = search.toLowerCase();

    if (
        !productCategory &&
        (normalizedSearch.includes("ноутбук") ||
            normalizedSearch.includes("laptop"))
    ) {
        productCategory = "laptop";
        search = "";
    }

    if (
        !productCategory &&
        (normalizedSearch.includes("телефон") ||
            normalizedSearch.includes("смартфон") ||
            normalizedSearch.includes("phone") ||
            normalizedSearch.includes("smartphone"))
    ) {
        productCategory = "phone";
        search = "";
    }

    let sql = `
        SELECT name, category, price, currency, stock
        FROM products
        WHERE 1 = 1
    `;

    const params = [];

    if (search) {
        sql += " AND LOWER(name) LIKE LOWER(?)";
        params.push(`%${search}%`);
    }

    if (productCategory) {
        sql += " AND category = ?";
        params.push(productCategory);
    }

    if (inStockOnly) {
        sql += " AND stock > 0";
    }

    sql += " ORDER BY name ASC LIMIT 20";

    const [rows] = await db.execute(sql, params);

    return {
        products: rows.map(product => ({
            name: product.name,
            category: product.category,
            price: Number(product.price),
            currency: product.currency,
            stock: product.stock
        }))
    };
}
async function createOrder(
    productName,
    quantity,
    idempotencyKey,
    expectedPrice,
    expectedCurrency,
    userId
) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
        return {
            error: "Количество должно быть положительным целым числом"
        };
    }
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();
        const [existingOrders] = await connection.execute(
            `SELECT order_number, product_name, quantity, total, currency
             FROM orders
             WHERE idempotency_key = ?
             LIMIT 1`,
            [idempotencyKey]
        );

        if (existingOrders.length > 0) {
            await connection.rollback();
            const existingOrder = existingOrders[0];
            return {
                success: true,
                alreadyExists: true,
                orderId: existingOrder.order_number,
                productName: existingOrder.product_name,
                quantity: existingOrder.quantity,
                total: Number(existingOrder.total),
                currency: existingOrder.currency
            };
        }
        const [rows] = await connection.execute(
            "SELECT id, name, price, currency, stock FROM products WHERE LOWER(name) = LOWER(?) LIMIT 1 FOR UPDATE",
            [productName]
        );

        if (rows.length === 0) {
            await connection.rollback();
            return { error: "Товар не найден" };
        }
        const product = rows[0];
        const currentPrice = Number(product.price);
        if (
            currentPrice !== expectedPrice ||
            product.currency !== expectedCurrency
        ) {
            await connection.rollback();

            return {
                error: "PRICE_CHANGED",
                oldPrice: expectedPrice,
                newPrice: currentPrice,
                oldCurrency: expectedCurrency,
                newCurrency: product.currency
            };
        }
        if (product.stock < quantity) {
            await connection.rollback();
            return { error: "Недостаточно товара на складе" };
        }
        const price = Number(product.price);
        const total = price * quantity;
        const orderNumber = "ORDER-" + crypto.randomUUID();

        await connection.execute(
            "UPDATE products SET stock = stock - ? WHERE id = ?",
            [quantity, product.id]
        );

        await connection.execute(
            `INSERT INTO orders
             (user_id, order_number, product_id, product_name, quantity, unit_price, total, currency, idempotency_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                userId,
                orderNumber,
                product.id,
                product.name,
                quantity,
                price,
                total,
                product.currency,
                idempotencyKey
            ]
        );

        await connection.commit();

        return {
            success: true,
            orderId: orderNumber,
            productName: product.name,
            quantity,
            total,
            currency: product.currency
        };

    } catch (error) {
        await connection.rollback();
        if (error.code === "ER_DUP_ENTRY") {
            const [existingOrders] = await db.execute(
                `SELECT order_number, product_name, quantity, total, currency
             FROM orders
             WHERE idempotency_key = ?
             LIMIT 1`,
                [idempotencyKey]
            );
            if (existingOrders.length > 0) {
                const existingOrder = existingOrders[0];
                return {
                    success: true,
                    alreadyExists: true,
                    orderId: existingOrder.order_number,
                    productName: existingOrder.product_name,
                    quantity: existingOrder.quantity,
                    total: Number(existingOrder.total),
                    currency: existingOrder.currency
                };
            }
        }
        throw error;
    } finally {
        connection.release();
    }
}

async function executeTool(name, input) {

    if (name === "check_stock") {
        return await checkStock(input.productName);
    }

    if (name === "get_price") {
        return await getPrice(input.productName);
    }

    if (name === "search_products") {
        return await searchProducts(
            input.query,
            input.inStockOnly,
            input.category
        );
    }
    return {
        error: "Неизвестный инструмент"
    };
}

const tools = [
    {
        name: "check_stock",
        description: "Проверить актуальное количество товара на складе",
        input_schema: {
            type: "object",
            properties: {
                productName: {
                    type: "string",
                    description: "Полное название товара"
                }
            },
            required: ["productName"]
        }
    },
    {
        name: "get_price",
        description: "Получить актуальную цену товара",
        input_schema: {
            type: "object",
            properties: {
                productName: {
                    type: "string",
                    description: "Полное название товара"
                }
            },
            required: ["productName"]
        }
    },
    {
        name: "search_products",
        description: "Найти товары в каталоге. Используй этот инструмент, когда пользователь спрашивает, какие товары есть, что есть в наличии, какие есть модели, категории или товары определённого бренда.",
        input_schema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Поисковый запрос. Например: Samsung, iPhone. Для просмотра всех товаров подходящей категории передай пустую строку."
                },
                inStockOnly: {
                    type: "boolean",
                    description: "true, если пользователь спрашивает только товары в наличии"
                },
                category: {
                    type: "string",
                    enum: ["phone", "laptop", "other"],
                    description: "Категория товара. Для запросов о телефонах или смартфонах ОБЯЗАТЕЛЬНО используй phone. Для запросов о ноутбуках ОБЯЗАТЕЛЬНО используй laptop. Если пользователь спрашивает категорию целиком, например 'какие ноутбуки есть?', передавай query как пустую строку и category='laptop'. Если спрашивает 'какие телефоны есть?', передавай query как пустую строку и category='phone'."
                }
            },
            required: ["query", "inStockOnly"]
        }
    },
    {
        name: "create_order",
        description: "Создать заказ на товар",
        input_schema: {
            type: "object",
            properties: {
                productName: {
                    type: "string",
                    description: "Полное название товара"
                },
                quantity: {
                    type: "integer",
                    description: "Количество товара"
                }
            },
            required: ["productName", "quantity"]
        }
    }
];

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        answer: "Слишком много запросов. Попробуйте снова через минуту."
    }
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Слишком много попыток. Попробуйте снова через 15 минут."
    }
});

app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());
app.use(express.static("public"));
app.use(
    "/vendor/marked",
    express.static("node_modules/marked/lib")
);

app.use(
    "/vendor/dompurify",
    express.static("node_modules/dompurify/dist")
);

const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;
const PENDING_ORDER_TTL = 15 * 60 * 1000;

function getSession(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
            conversation: [],
            pendingOrder: null,
            lastAccess: Date.now()
        });
    }
    sessions.get(sessionId).lastAccess = Date.now();
    return sessions.get(sessionId);
}
setInterval(() => {
    const now = Date.now();

    for (const [sessionId, session] of sessions) {
        if (now - session.lastAccess > SESSION_TTL) {
            sessions.delete(sessionId);
        }
    }
}, 5 * 60 * 1000);
async function ensureSession(sessionId, userId) {
    await db.execute(
        `INSERT INTO sessions (session_id, user_id)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE
         updated_at = CURRENT_TIMESTAMP`,
        [sessionId, userId]
    );
}

async function sessionBelongsToUser(sessionId, userId) {
    const [rows] = await db.execute(
        `SELECT user_id
         FROM sessions
         WHERE session_id = ?
         LIMIT 1`,
        [sessionId]
    );
    if (rows.length === 0) {
        return true;
    }
    return rows[0].user_id === userId;
}

async function savePendingOrder(sessionId, pendingOrder) {
    await db.execute(
        `UPDATE sessions
         SET pending_order = ?
         WHERE session_id = ?`,
        [
            pendingOrder ? JSON.stringify(pendingOrder) : null,
            sessionId
        ]
    );
}
async function loadPendingOrder(sessionId) {
    const [rows] = await db.execute(
        `SELECT pending_order
         FROM sessions
         WHERE session_id = ?
         LIMIT 1`,
        [sessionId]
    );
    if (rows.length === 0 || !rows[0].pending_order) {
        return null;
    }
    const pendingOrder = rows[0].pending_order;
    return typeof pendingOrder === "string"
        ? JSON.parse(pendingOrder)
        : pendingOrder;
}
app.get("/health", async (req, res) => {
    try {
        await db.execute("SELECT 1");

        res.status(200).json({
            status: "ok",
            database: "ok"
        });
    } catch (error) {
        res.status(503).json({
            status: "error",
            database: "unavailable"
        });
    }
});
app.post("/api/register", authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        if (
            typeof email !== "string" ||
            typeof password !== "string"
        ) {
            return res.status(400).json({
                error: "Email и пароль должны быть строками."
            });
        }
        const normalizedEmail = email.trim().toLowerCase();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (
            !normalizedEmail ||
            normalizedEmail.length > 255 ||
            !emailRegex.test(normalizedEmail)
        ) {
            return res.status(400).json({
                error: "Укажите корректный email."
            });
        }
        if (password.length < 8 || password.length > 128) {
            return res.status(400).json({
                error: "Пароль должен содержать от 8 до 128 символов."
            });
        }
        const [existingUsers] = await db.execute(
            "SELECT id FROM users WHERE email = ? LIMIT 1",
            [normalizedEmail]
        );
        if (existingUsers.length > 0) {
            return res.status(409).json({
                error: "Пользователь с таким email уже существует."
            });
        }
        const passwordHash = await bcrypt.hash(password, 12);
        const [result] = await db.execute(
            `INSERT INTO users (email, password_hash)
             VALUES (?, ?)`,
            [normalizedEmail, passwordHash]
        );
        return res.status(201).json({
            id: result.insertId,
            email: normalizedEmail
        });
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                error: "Пользователь с таким email уже существует."
            });

        }
        console.error("Ошибка регистрации:", error);
        return res.status(500).json({
            error: "Не удалось зарегистрировать пользователя."
        });
    }
});

app.post("/api/login", authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;

        if (
            typeof email !== "string" ||
            typeof password !== "string" ||
            !email.trim() ||
            !password
        ) {
            return res.status(400).json({
                error: "Укажите email и пароль."
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        const [users] = await db.execute(
            `SELECT id, email, password_hash, role
             FROM users
             WHERE email = ?
             LIMIT 1`,
            [normalizedEmail]
        );

        if (users.length === 0) {
            return res.status(401).json({
                error: "Неверный email или пароль."
            });
        }

        const user = users[0];

        const passwordIsCorrect = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!passwordIsCorrect) {
            return res.status(401).json({
                error: "Неверный email или пароль."
            });
        }

        const token = jwt.sign(
            {
                userId: user.id,
                email: user.email,
                role: user.role
            },
            process.env.JWT_SECRET,
            { expiresIn: "15m" }
        );
        const refreshToken = generateRefreshToken();
        await saveRefreshToken(user.id, refreshToken);
        res.cookie("refreshToken", refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            maxAge: 30 * 24 * 60 * 60 * 1000
        });
        return res.json({ token });

    } catch (error) {
        console.error("Ошибка входа:", error);

        return res.status(500).json({
            error: "Не удалось выполнить вход."
        });
    }
});

function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
            error: "Требуется авторизация."
        });
    }

    const token = authHeader.slice(7);

    try {
        const payload = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        req.user = payload;
        next();

    } catch (error) {
        return res.status(401).json({
            error: "Недействительный или просроченный токен."
        });
    }
}

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== "admin") {
        return res.status(403).json({
            error: "Доступ запрещён."
        });
    }

    next();
}

app.get("/api/admin/products", authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [products] = await db.execute(
            `SELECT id, name, category, price, currency, stock
             FROM products
             ORDER BY id ASC`
        );

        res.json({ products });
    } catch (error) {
        console.error("Admin products error:", error);

        res.status(500).json({
            error: "Не удалось получить список товаров."
        });
    }
});

app.patch("/api/admin/products/:id", authenticateToken, requireAdmin, async (req, res) => {
    try {
        const productId = Number(req.params.id);
        const { name, category, price, currency, stock } = req.body;

        if (!Number.isInteger(productId) || productId <= 0) {
            return res.status(400).json({ error: "Некорректный ID товара." });
        }

        const [currentRows] = await db.execute(
            `SELECT id, name, category, price, currency, stock
             FROM products WHERE id = ? LIMIT 1`,
            [productId]
        );
        if (currentRows.length === 0) {
            return res.status(404).json({ error: "Товар не найден." });
        }

        const current = currentRows[0];
        const newName = name === undefined ? current.name : String(name).trim();
        const newCategory = category === undefined ? current.category : String(category).trim();
        const newCurrency = currency === undefined ? current.currency : String(currency).trim().toUpperCase();
        const newPrice = price === undefined ? Number(current.price) : Number(price);
        const newStock = stock === undefined ? Number(current.stock) : Number(stock);

        if (!newName || newName.length > 255) return res.status(400).json({ error: "Некорректное название." });
        if (!newCategory || newCategory.length > 50) return res.status(400).json({ error: "Некорректная категория." });
        if (!newCurrency || newCurrency.length > 10) return res.status(400).json({ error: "Некорректная валюта." });
        if (!Number.isFinite(newPrice) || newPrice < 0) return res.status(400).json({ error: "Некорректная цена." });
        if (!Number.isInteger(newStock) || newStock < 0) return res.status(400).json({ error: "Некорректный остаток." });

        const [result] = await db.execute(
            `UPDATE products
             SET name = ?, category = ?, price = ?, currency = ?, stock = ?
             WHERE id = ?`,
            [newName, newCategory, newPrice, newCurrency, newStock, productId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                error: "Товар не найден."
            });
        }

        const [products] = await db.execute(
            `SELECT id, name, category, price, currency, stock
             FROM products
             WHERE id = ?
             LIMIT 1`,
            [productId]
        );

        res.json({
            product: products[0]
        });
    } catch (error) {
        console.error("Admin update product error:", error);

        res.status(500).json({
            error: "Не удалось обновить товар."
        });
    }
});

app.post("/api/admin/products", authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { name, category = "other", price, currency = "EUR", stock = 0 } = req.body;
        const cleanName = typeof name === "string" ? name.trim() : "";
        const cleanCategory = typeof category === "string" ? category.trim() : "";
        const cleanCurrency = typeof currency === "string" ? currency.trim().toUpperCase() : "";
        const newPrice = Number(price);
        const newStock = Number(stock);

        if (!cleanName || cleanName.length > 255) return res.status(400).json({ error: "Некорректное название." });
        if (!cleanCategory || cleanCategory.length > 50) return res.status(400).json({ error: "Некорректная категория." });
        if (!cleanCurrency || cleanCurrency.length > 10) return res.status(400).json({ error: "Некорректная валюта." });
        if (!Number.isFinite(newPrice) || newPrice < 0) return res.status(400).json({ error: "Некорректная цена." });
        if (!Number.isInteger(newStock) || newStock < 0) return res.status(400).json({ error: "Некорректный остаток." });

        const [result] = await db.execute(
            `INSERT INTO products (name, category, price, currency, stock) VALUES (?, ?, ?, ?, ?)`,
            [cleanName, cleanCategory, newPrice, cleanCurrency, newStock]
        );
        const [products] = await db.execute(
            `SELECT id, name, category, price, currency, stock FROM products WHERE id = ? LIMIT 1`,
            [result.insertId]
        );
        return res.status(201).json({ product: products[0] });
    } catch (error) {
        console.error("Admin create product error:", error);
        return res.status(500).json({ error: "Не удалось добавить товар." });
    }
});

app.delete(
    "/api/admin/products/:id",
    authenticateToken,
    requireAdmin,
    async (req, res) => {
        try {
            const productId = Number(req.params.id);

            if (!Number.isInteger(productId) || productId <= 0) {
                return res.status(400).json({
                    error: "Некорректный ID товара."
                });
            }

            const [orders] = await db.execute(
                "SELECT id FROM orders WHERE product_id = ? LIMIT 1",
                [productId]
            );

            if (orders.length > 0) {
                return res.status(409).json({
                    error: "Товар нельзя удалить, потому что он есть в истории заказов."
                });
            }

            const [result] = await db.execute(
                "DELETE FROM products WHERE id = ?",
                [productId]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({
                    error: "Товар не найден."
                });
            }

            return res.json({
                success: true
            });

        } catch (error) {
            console.error("Admin delete product error:", error);

            if (error.code === "ER_ROW_IS_REFERENCED_2") {
                return res.status(409).json({
                    error: "Нельзя удалить товар: по нему уже есть заказы."
                });
            }

            return res.status(500).json({
                error: "Не удалось удалить товар."
            });
        }
    }
);

app.post("/api/refresh", async (req, res) => {
    try {
        const refreshToken = req.cookies.refreshToken;

        if (!refreshToken) {
            return res.status(401).json({
                error: "Refresh token отсутствует."
            });
        }

        const tokenHash = hashRefreshToken(refreshToken);

        const [rows] = await db.execute(
            `SELECT rt.id, rt.user_id, u.email, u.role
             FROM refresh_tokens rt
                      JOIN users u ON u.id = rt.user_id
             WHERE rt.token_hash = ?
               AND rt.revoked_at IS NULL
               AND rt.expires_at > NOW()
                 LIMIT 1`,
            [tokenHash]
        );

        if (rows.length === 0) {
            return res.status(401).json({
                error: "Refresh token недействителен или истёк."
            });
        }

        const user = rows[0];

        // Старый refresh token больше использовать нельзя
        await db.execute(
            `UPDATE refresh_tokens
             SET revoked_at = NOW()
             WHERE id = ?`,
            [user.id]
        );

        // Создаём новый refresh token
        const newRefreshToken = generateRefreshToken();

        await saveRefreshToken(
            user.user_id,
            newRefreshToken
        );

        // Создаём новый короткоживущий access token
        const token = jwt.sign(
            {
                userId: user.user_id,
                email: user.email,
                role: user.role
            },
            process.env.JWT_SECRET,
            { expiresIn: "15m" }
        );

        // Заменяем refresh token в HttpOnly cookie
        res.cookie("refreshToken", newRefreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            maxAge: 30 * 24 * 60 * 60 * 1000
        });

        return res.json({ token });

    } catch (error) {
        console.error("Ошибка обновления токена:", error);

        return res.status(500).json({
            error: "Не удалось обновить токен."
        });
    }
});

app.post("/api/logout", async (req, res) => {
    try {
        const refreshToken = req.cookies.refreshToken;

        if (refreshToken) {
            const tokenHash = hashRefreshToken(refreshToken);

            await db.execute(
                `UPDATE refresh_tokens
                 SET revoked_at = NOW()
                 WHERE token_hash = ?
                   AND revoked_at IS NULL`,
                [tokenHash]
            );
        }

        res.clearCookie("refreshToken", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict"
        });

        return res.json({
            message: "Выход выполнен."
        });

    } catch (error) {
        console.error("Ошибка выхода:", error);

        return res.status(500).json({
            error: "Не удалось выполнить выход."
        });
    }
});

app.get("/api/orders", authenticateToken, async (req, res) => {
    try {
        const [orders] = await db.execute(
            `SELECT
                order_number,
                product_name,
                quantity,
                unit_price,
                total,
                currency,
                created_at
             FROM orders
             WHERE user_id = ?
             ORDER BY created_at DESC`,
            [req.user.userId]
        );
        return res.json({
            orders
        });
    } catch (error) {
        console.error("Ошибка получения заказов:", error);

        return res.status(500).json({
            error: "Не удалось получить заказы."
        });
    }
});

app.post(
    "/api/chat",
    chatLimiter,
    authenticateToken,
    async (req, res) => {
    try {
        const message = req.body.message;
        const sessionId = req.body.sessionId || "default";
        if (
            typeof sessionId !== "string" ||
            !/^[a-zA-Z0-9-]{1,100}$/.test(sessionId)
        ) {
            return res.status(400).json({
                answer: "Некорректный идентификатор сессии."
            });
        }

        async function saveMessage(sessionId, role, content) {
            await db.execute(
                `INSERT INTO messages (session_id, role, content)
                VALUES (?, ?, ?)`,
                [sessionId, role, content]
            );
        }
        async function loadMessages(sessionId) {
            const [rows] = await db.execute(
                `SELECT role, content
                 FROM (
                    SELECT id, role, content
                    FROM messages
                    WHERE session_id = ?
                    ORDER BY id DESC
                    LIMIT 20
                 ) AS recent_messages
                 ORDER BY id ASC`,
                [sessionId]
            );

            return rows.map(row => ({
                role: row.role,
                content: row.content
            }));
        }
        if (typeof message !== "string" || !message.trim()) {
            return res.status(400).json({
                answer: "Введите сообщение."
            });
        }
        if (message.length > 5000) {
            return res.status(400).json({
                answer: "Сообщение слишком длинное. Максимум 5000 символов."
            });
        }
        const belongsToUser = await sessionBelongsToUser(
            sessionId,
            req.user.userId
        );
        if (!belongsToUser) {
            return res.status(403).json({
                error: "Нет доступа к этой сессии."
            });
        }
        const session = getSession(sessionId);
        await ensureSession(sessionId, req.user.userId);
        if (!session.pendingOrder) {
            session.pendingOrder = await loadPendingOrder(sessionId);
        }
        if (session.conversation.length === 0) {
            session.conversation = await loadMessages(sessionId);
        }
        const confirmationWords = [
            "да",
            "подтверждаю",
            "подтвердить",
            "да, подтверждаю",
            "ок",
            "окей",
            "оформляй",
            "беру",
            "давай"
        ];
        const isConfirmation = confirmationWords.includes(
            message.toLowerCase().trim()
        );

        if (isConfirmation && !session.pendingOrder) {
            return res.json({
                answer: "Нет заказа, ожидающего подтверждения."
            });
        }
        if (session.pendingOrder && isConfirmation) {
            if (
                !session.pendingOrder.createdAt ||
                Date.now() - session.pendingOrder.createdAt > PENDING_ORDER_TTL
            ) {
                session.pendingOrder = null;
                await savePendingOrder(sessionId, null);

                return res.status(410).json({
                    answer: "Время подтверждения заказа истекло. Оформите заказ заново."
                });
            }
            const result = await createOrder(
                session.pendingOrder.productName,
                session.pendingOrder.quantity,
                session.pendingOrder.idempotencyKey,
                session.pendingOrder.price,
                session.pendingOrder.currency,
                req.user.userId
            );
            if (result.error === "PRICE_CHANGED") {
                session.pendingOrder = null;
                await savePendingOrder(sessionId, null);
                return res.status(409).json({
                    answer:
                        `Цена товара изменилась с ${result.oldPrice} ${result.oldCurrency} ` +
                        `на ${result.newPrice} ${result.newCurrency}. ` +
                        `Заказ не создан. Оформите его заново по новой цене.`
                });
            }
            if (result.error) {
                session.pendingOrder = null;
                await savePendingOrder(sessionId, null);
                return res.status(400).json({
                    answer: result.error
                });
            }

            session.pendingOrder = null;
            await savePendingOrder(sessionId, null);
            await saveMessage(sessionId, "user", message);

            const confirmationText =
                `Заказ успешно создан.\n\n` +
                `Номер заказа: ${result.orderId}\n` +
                `Товар: ${result.productName}\n` +
                `Количество: ${result.quantity} шт.\n` +
                `Сумма: ${result.total} ${result.currency}`;

            session.conversation.push(
                {
                    role: "user",
                    content: message
                },
                {
                    role: "assistant",
                    content: confirmationText
                }
            );

            await saveMessage(
                sessionId,
                "assistant",
                confirmationText
            );

            return res.json({
                answer: confirmationText,
                type: "order_success",
                order: {
                    orderId: result.orderId,
                    productName: result.productName,
                    quantity: result.quantity,
                    total: result.total,
                    currency: result.currency
                }
            });
        }

        console.log("Пользователь:", message);

        let recentConversation = session.conversation.slice(-20);
        if (
            recentConversation.length > 0 &&
            recentConversation[0].role === "assistant"
        ) {
            recentConversation = recentConversation.slice(1);
        }
        const messages = [
            ...recentConversation,
            {
                role: "user",
                content: message
            }
        ];

        const catalogQuestion = /(каталог|ассортимент|товар|модел|бренд|телефон|смартфон|ноутбук|iphone|samsung|macbook|налич|склад|цена|стоим)/i.test(message);
        let catalogCheckedThisTurn = false;

        for (let step = 1; step <= 10; step++) {

            console.log(`\n--- Шаг агента ${step} ---`);

            const response = await anthropic.messages.create({
                model: "claude-sonnet-4-5",
                max_tokens: 500,

                system: `
    Ты AI-агент магазина электроники.

    ОСНОВНОЕ ПРАВИЛО:

    Все факты об ассортименте магазина получай только через инструменты.

    Никогда не придумывай товары, модели, цены, наличие или возможности магазина.

    КРИТИЧЕСКОЕ ПРАВИЛО:

    На ЛЮБОЙ вопрос пользователя об ассортименте, наличии товаров,
    
    категориях, брендах или моделях ОБЯЗАТЕЛЬНО вызывай search_products
    
    в текущем сообщении.

    Никогда не отвечай на такой вопрос только на основании истории диалога,
    
    предыдущих результатов инструментов или собственных знаний.
    
    РАБОТА С КАТАЛОГОМ:

    1. Если пользователь спрашивает:

       - какие товары есть;

       - что есть в наличии;

       - какие есть телефоны;

       - какие есть Samsung, iPhone или товары другого бренда;

       - просит показать ассортимент;

       используй search_products.

    2. Если пользователь указал только часть названия или бренд,

       например "Samsung" или "iPhone", используй search_products,

       а не придумывай полное название модели.

    3. Если пользователь спрашивает "какие есть?", "а что есть?",

       "покажи ещё" и подобным образом продолжает предыдущий вопрос,

       учитывай контекст предыдущих сообщений.

    4. Если search_products вернул пустой список,

       честно сообщи, что подходящих товаров в каталоге не найдено.

    5. Не предлагай в качестве примеров модели,

       которых не было в результатах инструментов.

    6. Не говори пользователю "посмотрите каталог на сайте",

       "обратитесь к менеджеру" или о других возможностях магазина,

       если таких возможностей нет в полученных данных.

    7. Если пользователь спрашивает о конкретном товаре,

       используй инструменты для проверки фактических данных.

    8. Если пользователь спрашивает о телефонах, смартфонах

       или моделях телефонов, используй search_products

       с category="phone".

    9. Если пользователь спрашивает о ноутбуках,

       используй search_products с category="laptop".
       
       Если пользователь спрашивает, какие товары "есть",
       
        это означает наличие товаров в каталоге, а не наличие на складе.

        Используй inStockOnly=true только если пользователь явно спрашивает
        
        "в наличии", "на складе", "можно купить сейчас" или аналогично.

    10. Если пользователь спрашивает весь каталог

        без указания типа товара, не передавай category.

    11. Не определяй ассортимент по своим знаниям.

        Категория только ограничивает поиск по реальным товарам из базы.

    ОФОРМЛЕНИЕ ЗАКАЗА:

    Перед оформлением заказа обязательно:

    1. Проверь наличие товара.

    2. Получи актуальную цену.

    3. Не оформляй заказ, если товара недостаточно.

    4. После проверки наличия и цены ОБЯЗАТЕЛЬНО вызови create_order.

    5. Самостоятельно текстом подтверждение заказа НЕ запрашивай.

    6. Если create_order вернул requiresConfirmation: true,

       заказ ЕЩЁ НЕ создан. Сообщи пользователю товар, количество

       и стоимость и попроси явно подтвердить заказ.

    7. Никогда не говори, что заказ создан, если create_order

       не вернул success: true.

    Отвечай кратко и по существу.
    `,

                tools: tools,
                ...(catalogQuestion && !catalogCheckedThisTurn
                    ? { tool_choice: { type: "tool", name: "search_products" } }
                    : {}),
                messages: messages
            });

            messages.push({
                role: "assistant",
                content: response.content
            });

            const toolUses = response.content.filter(
                item => item.type === "tool_use"
            );

            // Если Claude больше не вызывает инструменты —
            // значит он сформировал финальный ответ.
            if (toolUses.length === 0) {
                if (catalogQuestion && !catalogCheckedThisTurn) {
                    messages.push({
                        role: "user",
                        content: "Перед финальным ответом обязательно проверь актуальный каталог через search_products. Не делай вывод об ассортименте из истории или собственных знаний."
                    });
                    continue;
                }

                if (
                    !session.pendingOrder &&
                    /подтверждаете заказ|подтвердите заказ/i.test(
                        response.content
                            .filter(item => item.type === "text")
                            .map(item => item.text)
                            .join(" ")
                    )
                ) {
                    messages.push({
                        role: "user",
                        content: `Ты запросил подтверждение заказа без вызова create_order.
                        Сначала обязательно вызови create_order с нужным товаром и количеством.
                        Не отвечай пользователю текстом до вызова create_order.`
                    });

                    continue;
                }
                const text = response.content.find(
                    item => item.type === "text"
                );

                console.log("Финальный ответ:", text?.text);
                session.conversation.push(
                    {
                        role: "user",
                        content: message
                    },
                    {
                        role: "assistant",
                        content: text?.text || "Нет ответа"
                    }
                );
                await saveMessage(sessionId, "user", message);
                await saveMessage(
                    sessionId,
                    "assistant",
                    text?.text || "Нет ответа"
                );
                return res.json({
                    answer: text?.text || "Нет ответа"
                });
            }
            const toolResults = [];
            for (const toolUse of toolUses) {
                if (toolUse.name === "search_products") {
                    catalogCheckedThisTurn = true;
                }
                console.log(
                    "Claude вызывает:",
                    toolUse.name,
                    toolUse.input
                );
                let result;
                if (toolUse.name === "create_order") {
                    const quantity = Number(toolUse.input.quantity);
                    if (!Number.isInteger(quantity) || quantity <= 0) {
                        result = { error: "Количество должно быть положительным целым числом" };
                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: toolUse.id,
                            content: JSON.stringify(result)
                        });
                        continue;
                    }

                    const stockInfo = await checkStock(toolUse.input.productName);
                    if (stockInfo.error || stockInfo.stock < quantity) {
                        result = stockInfo.error
                            ? { error: stockInfo.error }
                            : { error: "Недостаточно товара на складе", available: stockInfo.stock };
                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: toolUse.id,
                            content: JSON.stringify(result)
                        });
                        continue;
                    }

                    const priceInfo = await getPrice(
                        toolUse.input.productName
                    );
                    if (priceInfo.error) {
                        result = {
                            error: priceInfo.error
                        };
                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: toolUse.id,
                            content: JSON.stringify(result)
                        });
                        continue;
                    }
                    session.pendingOrder = {
                        productName: toolUse.input.productName,
                        quantity,
                        price: priceInfo.price,
                        currency: priceInfo.currency,
                        idempotencyKey: crypto.randomUUID(),
                        createdAt: Date.now()
                    };
                    await savePendingOrder(
                        sessionId,
                        session.pendingOrder
                    );

                    result = {
                        requiresConfirmation: true,
                        message: "Заказ ожидает подтверждения пользователя",
                        productName: toolUse.input.productName,
                        quantity
                    };

                } else {

                    result = await executeTool(toolUse.name, toolUse.input);
                }

                console.log("Результат:", result);

                toolResults.push({
                    type: "tool_result",
                    tool_use_id: toolUse.id,
                    content: JSON.stringify(result)
                });
            }

            messages.push({
                role: "user",
                content: toolResults
            });
        }

        res.status(500).json({
            answer: "Агент превысил максимальное количество шагов."
        });
    } catch (error) {

        console.error("Ошибка сервера:", error);

        return res.status(500).json({

            answer: "Произошла ошибка. Попробуйте ещё раз."

        });

    }
});
app.use((error, req, res, next) => {
    if (error.type === "entity.too.large") {
        return res.status(413).json({
            answer: "Запрос слишком большой."
        });
    }
    if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
        return res.status(400).json({
            answer: "Некорректный JSON."
        });
    }
    console.error("Необработанная ошибка:", error);

    return res.status(500).json({
        answer: "Внутренняя ошибка сервера."
    });
});
app.listen(3000, () => {
    console.log("Сервер запущен:");
    console.log("http://localhost:3000");
});