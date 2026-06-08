import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "root",
  database: process.env.DB_NAME || "chat_app",
};

if (!/^[a-zA-Z0-9_]+$/.test(dbConfig.database)) {
  throw new Error("DB_NAME 只能使用英文字母、數字與底線");
}

async function ensureDatabase() {
  const connection = await mysql.createConnection({
    host: dbConfig.host,
    user: dbConfig.user,
    password: dbConfig.password,
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`
       CHARACTER SET utf8mb4
       COLLATE utf8mb4_unicode_ci`,
    );
  } catch (error) {
    if (error.code !== "ER_DBACCESS_DENIED_ERROR") {
      throw error;
    }
  } finally {
    await connection.end();
  }
}

await ensureDatabase();

const pool = mysql.createPool({
  ...dbConfig,
  waitForConnections: true,
  connectionLimit: 10,
  charset: "utf8mb4",
});

async function ensureColumn(table, column, definition) {
  const [columns] = await pool.execute(`SHOW COLUMNS FROM ${table}`);
  const columnNames = new Set(columns.map((item) => item.Field));

  if (!columnNames.has(column)) {
    await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

export async function initDatabase() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS rooms (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(60) NOT NULL,
      normalized_name VARCHAR(60) NULL,
      password_hash VARCHAR(64) NULL,
      creator_client_id VARCHAR(64) NULL,
      creator_name VARCHAR(24) NULL,
      creator_ip VARCHAR(64) NULL,
      max_users INT NOT NULL DEFAULT 100,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_rooms_creator_ip (creator_ip),
      INDEX idx_rooms_normalized_name (normalized_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await ensureColumn(
    "rooms",
    "normalized_name",
    "normalized_name VARCHAR(60) NULL AFTER name",
  );
  await ensureColumn(
    "rooms",
    "creator_client_id",
    "creator_client_id VARCHAR(64) NULL AFTER password_hash",
  );
  await ensureColumn(
    "rooms",
    "creator_name",
    "creator_name VARCHAR(24) NULL AFTER creator_client_id",
  );
  await ensureColumn(
    "rooms",
    "creator_ip",
    "creator_ip VARCHAR(64) NULL AFTER creator_name",
  );
  await ensureColumn(
    "rooms",
    "max_users",
    "max_users INT NOT NULL DEFAULT 100 AFTER creator_ip",
  );

  await pool.execute(`
    UPDATE rooms
    SET normalized_name = LOWER(TRIM(name))
    WHERE normalized_name IS NULL
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      room_id VARCHAR(36) NOT NULL,
      sender VARCHAR(100) NOT NULL,
      message TEXT NOT NULL,
      message_type ENUM('room', 'private') NOT NULL DEFAULT 'room',
      recipient_socket_id VARCHAR(128) NULL,
      recipient_name VARCHAR(24) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_messages_room_created (room_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await ensureColumn(
    "messages",
    "message_type",
    "message_type ENUM('room', 'private') NOT NULL DEFAULT 'room' AFTER message",
  );
  await ensureColumn(
    "messages",
    "recipient_socket_id",
    "recipient_socket_id VARCHAR(128) NULL AFTER message_type",
  );
  await ensureColumn(
    "messages",
    "recipient_name",
    "recipient_name VARCHAR(24) NULL AFTER recipient_socket_id",
  );

  await pool.execute(
    `
    INSERT INTO rooms (
      id,
      name,
      normalized_name,
      password_hash,
      creator_client_id,
      creator_name,
      creator_ip,
      max_users
    )
    VALUES ('public', '公開聊天室', '公開聊天室', NULL, NULL, NULL, NULL, 100)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      normalized_name = VALUES(normalized_name),
      max_users = VALUES(max_users)
    `,
  );
}

export default pool;
