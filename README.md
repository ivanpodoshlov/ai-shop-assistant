# AI Shop Assistant

Учебный production-проект AI-ассистента интернет-магазина.

Пользователь может зарегистрироваться, войти в аккаунт, общаться с AI-ассистентом, узнавать цены и наличие товаров и создавать заказы через чат.

## Возможности

- регистрация и авторизация пользователей;
- безопасное хранение паролей с bcrypt;
- JWT access tokens;
- refresh tokens в HttpOnly cookie;
- сохранение пользователей, диалогов и заказов в MariaDB;
- AI-ассистент на Anthropic Claude;
- tool calling для получения цены и наличия товара;
- подтверждение заказа перед созданием;
- проверка актуальной цены перед заказом;
- защита от повторного создания заказа;
- привязка чатов и заказов к пользователю;
- rate limiting;
- Helmet security headers;
- Docker и Docker Compose;
- persistent MariaDB storage;
- health endpoint.

## Стек

- Node.js
- Express
- Anthropic API
- MariaDB
- mysql2
- bcrypt
- JSON Web Token
- Docker
- Docker Compose
- HTML / JavaScript

## Запуск через Docker

### 1. Создайте `.env`

Скопируйте:

```bash
cp .env.example .env

```

Затем откройте `.env` и укажите свои значения:

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

### 2. Запустите приложение

```bash
docker compose up --build
```

После запуска приложение доступно по адресу:

```text
http://localhost:3000
```

### 3. Проверка состояния

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

## База данных

При первом запуске Docker автоматически создаёт необходимые таблицы и тестовые товары.

Данные MariaDB хранятся в Docker volume и сохраняются после перезапуска контейнеров.

## Безопасность

Файл `.env` не должен попадать в Git.

Для публикации используется `.env.example`, который содержит только названия необходимых переменных без реальных секретов.

## Статус

Проект находится в разработке в рамках обучения production-разработке AI-приложений.