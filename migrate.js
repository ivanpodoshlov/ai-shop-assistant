import fs from "fs/promises";
import path from "path";
import { db } from "./db.js";

async function migrate() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            filename VARCHAR(255) NOT NULL UNIQUE,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    const migrationsDir = path.join(process.cwd(), "db", "migrations");
    const files = (await fs.readdir(migrationsDir))
        .filter(file => file.endsWith(".sql"))
        .sort();
    for (const filename of files) {
        const [rows] = await db.execute(
            `SELECT id
             FROM schema_migrations
             WHERE filename = ?
             LIMIT 1`,
            [filename]
        );
        if (rows.length > 0) {
            console.log(`Пропуск: ${filename}`);
            continue;
        }
        const sql = await fs.readFile(
            path.join(migrationsDir, filename),
            "utf8"
        );
        console.log(`Миграция: ${filename}`);
        await db.query(sql);
        await db.execute(
            `INSERT INTO schema_migrations (filename)
             VALUES (?)`,
            [filename]
        );
        console.log(`Готово: ${filename}`);
    }
    console.log("Все миграции выполнены.");
    await db.end();
}
migrate().catch(error => {
    console.error("Ошибка миграции:", error);
    process.exit(1);
});
