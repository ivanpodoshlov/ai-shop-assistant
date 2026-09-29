# AI Shop Assistant

AI-ассистент интернет-магазина с авторизацией пользователей, интеграцией Claude, tool calling, базой данных и оформлением заказов через чат.

**Live demo:** https://ai-shop.podoshlov.com

## Возможности

- регистрация и авторизация пользователей;
- хранение паролей с bcrypt;
- JWT access tokens;
- rotating refresh tokens в HttpOnly cookie;
- восстановление сессии после обновления страницы;
- персональные чаты пользователей;
- AI-ассистент на Anthropic Claude;
- tool calling для получения цены и остатков;
- оформление заказа непосредственно через диалог;
- обязательное подтверждение заказа пользователем;
- повторная проверка цены перед созданием заказа;
- транзакционное изменение складских остатков;
- защита от повторного создания заказа через idempotency key;
- хранение пользователей, сообщений, товаров и заказов в MariaDB;
- сохранение данных после перезапуска контейнеров;
- rate limiting;
- security headers;
- database migrations;
- health checks;
- Docker Compose;
- Caddy reverse proxy;
- HTTPS;
- роли пользователей `user` и `admin`;
- защищённая административная панель;
- управление каталогом товаров из админ-панели;
- изменение цены и складского остатка;
- добавление и удаление товаров;
- серверная проверка прав администратора для admin API;
- deployment на VPS.

## Стек

### Backend

- Node.js
- Express
- Anthropic API
- mysql2
- bcrypt
- JSON Web Token

### Database

- MariaDB
- SQL migrations
- Docker persistent volumes

### Frontend

- HTML
- CSS
- JavaScript
- Marked
- DOMPurify

### Infrastructure

- Docker
- Docker Compose
- Caddy
- HTTPS
- VPS

## Как работает заказ

```text
Пользователь
    ↓
Claude
    ↓
Tool calling
    ↓
Проверка товара, цены и наличия
    ↓
Подтверждение пользователя
    ↓
Повторная проверка актуальных данных
    ↓
Транзакция MariaDB
    ↓
Создание заказа
```

Критические операции выполняются серверным кодом. AI не изменяет остатки и не создаёт заказ без подтверждения пользователя.

## Архитектура

```text
Browser
   │
 HTTPS
   │
 Caddy
   │
 Node.js / Express
   ├── Anthropic Claude API
   │
   └── MariaDB
        ├── users
        ├── refresh_tokens
        ├── sessions
        ├── messages
        ├── products
        └── orders
```

## Локальный запуск

Создайте `.env` на основе примера:

```bash
cp .env.example .env
```

Укажите необходимые переменные окружения:

```env
ANTHROPIC_API_KEY=your_anthropic_api_key
JWT_SECRET=your_long_random_jwt_secret

DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=ai_shop

DOCKER_DB_PASSWORD=your_database_password
DOCKER_DB_ROOT_PASSWORD=your_root_database_password
```

Запустите приложение:

```bash
docker compose up -d --build
```

## Health check

```text
GET /health
```

Успешный ответ:

```json
{
  "status": "ok",
  "database": "ok"
}
```

## Production

Приложение развёрнуто на VPS в Docker Compose.

Caddy работает как reverse proxy и обслуживает HTTPS. Node.js-контейнер не публикует порт приложения напрямую в интернет.

MariaDB использует persistent Docker volume, поэтому данные сохраняются после перезапуска контейнеров.

**Production:** https://ai-shop.podoshlov.com

## Безопасность

- bcrypt password hashing;
- short-lived JWT access tokens;
- rotating refresh tokens;
- HttpOnly refresh cookie;
- Secure cookie в production;
- SameSite cookie protection;
- rate limiting;
- Helmet security headers;
- server-side validation;
- parameterized SQL queries;
- разделение пользовательских сессий;
- idempotent order creation;
- environment variables для секретов;
- `.env` исключён из Git;
- HTTPS.

## Статус

**MVP завершён и работает в production.**
