import pool, { initDatabase } from "./db.js";
import express from "express";
import { createServer } from "http";
import { createHash, randomUUID } from "crypto";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const MESSAGE_MAX_CHARS = 100;
const MESSAGE_RATE_LIMIT_MS = 1000;
const DEFAULT_ROOM_MAX_USERS = 100;
const ROOM_MIN_USERS = 2;
const ROOM_MAX_USERS = 100;
const RETENTION_HOURS = 168;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

await initDatabase();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

const clientPath = path.join(__dirname, "../client");
const rooms = new Map();
const users = new Map();
const lastMessageAtByIp = new Map();

app.use(express.static(clientPath));

function hashPassword(password) {
  if (!password) return null;

  return createHash("sha256").update(password).digest("hex");
}

function formatTime(value = new Date()) {
  const date = new Date(value);
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");

  return `${hour}:${minute}`;
}

function normalizeRoomName(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function normalizeUsername(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isUsernameTaken(normalizedUsername, currentSocketId) {
  return [...users.entries()].some(
    ([socketId, user]) =>
      socketId !== currentSocketId && user.normalizedUsername === normalizedUsername,
  );
}

function getClientIp(socket) {
  const forwardedFor = socket.handshake.headers["x-forwarded-for"];
  const forwardedValue = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor;
  const rawIp = forwardedValue
    ? forwardedValue.split(",")[0].trim()
    : socket.handshake.address;

  return String(rawIp || "unknown").replace(/^::ffff:/, "");
}

function countChars(text) {
  return Array.from(text).length;
}

function isMessageRateLimited(ipAddress) {
  const now = Date.now();
  const lastMessageAt = lastMessageAtByIp.get(ipAddress) ?? 0;

  if (now - lastMessageAt < MESSAGE_RATE_LIMIT_MS) {
    return true;
  }

  lastMessageAtByIp.set(ipAddress, now);
  return false;
}

function getPublicRoom(room, user) {
  return {
    id: room.id,
    name: room.name,
    isPrivate: Boolean(room.passwordHash),
    maxUsers: room.maxUsers,
    canDelete:
      room.id !== "public" &&
      Boolean(room.creatorClientId) &&
      room.creatorClientId === user?.clientUserId,
  };
}

function getRoomList(socketId) {
  const user = users.get(socketId);

  return [...rooms.values()].map((room) => ({
    ...getPublicRoom(room, user),
    userCount: io.sockets.adapter.rooms.get(room.id)?.size ?? 0,
  }));
}

function getRoomUsers(roomId) {
  return [...users.entries()]
    .filter(([, user]) => user.currentRoomId === roomId)
    .map(([id, user]) => ({
      id,
      username: user.username,
    }));
}

function emitRoomList() {
  io.sockets.sockets.forEach((socket) => {
    socket.emit("room-list", getRoomList(socket.id));
  });
}

function emitRoomUsers(roomId) {
  if (!roomId) return;

  io.to(roomId).emit("room-users", getRoomUsers(roomId));
}

function findRoomByName(normalizedName) {
  return [...rooms.values()].find(
    (room) => room.normalizedName === normalizedName,
  );
}

function findRoomCreatedByIp(ipAddress) {
  return [...rooms.values()].find(
    (room) => room.id !== "public" && room.creatorIp === ipAddress,
  );
}

function getRoomOccupancy(roomId) {
  return io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
}

function validateOutgoingMessage(socket, payload, callback) {
  const user = users.get(socket.id);
  const rawText = String(payload?.text ?? "");
  const text = rawText.trim();

  if (!user?.currentRoomId || !text) return null;

  if (countChars(text) > MESSAGE_MAX_CHARS) {
    callback?.({
      ok: false,
      code: "MESSAGE_TOO_LONG",
      error: `每則訊息最多 ${MESSAGE_MAX_CHARS} 個字，請刪減後再送出。`,
      rejectedText: rawText,
    });
    return null;
  }

  if (isMessageRateLimited(user.ipAddress)) {
    callback?.({
      ok: false,
      code: "RATE_LIMITED",
      error: "發送太快了，每個 IP 一秒只能發送一次訊息。",
      rejectedText: rawText,
    });
    return null;
  }

  return { user, text };
}

async function loadRooms() {
  const [rows] = await pool.execute(
    `
    SELECT
      id,
      name,
      normalized_name AS normalizedName,
      password_hash AS passwordHash,
      creator_client_id AS creatorClientId,
      creator_name AS creatorName,
      creator_ip AS creatorIp,
      max_users AS maxUsers,
      created_at AS createdAt
    FROM rooms
    ORDER BY created_at ASC
    `,
  );

  rooms.clear();

  rows.forEach((room) => {
    rooms.set(room.id, {
      id: room.id,
      name: room.name,
      normalizedName: room.normalizedName || normalizeRoomName(room.name),
      passwordHash: room.passwordHash,
      creatorClientId: room.creatorClientId,
      creatorName: room.creatorName,
      creatorIp: room.creatorIp,
      maxUsers: Number(room.maxUsers || DEFAULT_ROOM_MAX_USERS),
      createdAt: room.createdAt,
    });
  });
}

async function getRoomHistory(roomId) {
  const [rows] = await pool.execute(
    `
    SELECT
      id,
      sender,
      message AS text,
      created_at AS createdAt
    FROM messages
    WHERE room_id = ?
      AND message_type = 'room'
    ORDER BY created_at ASC
    LIMIT 100
    `,
    [roomId],
  );

  return rows.map((message) => ({
    id: message.id,
    sender: message.sender,
    text: message.text,
    time: formatTime(message.createdAt),
    isPrivate: false,
  }));
}

async function joinRoom(socket, roomId) {
  const user = users.get(socket.id);
  const room = rooms.get(roomId);

  if (!user || !room) return;

  const previousRoomId = user.currentRoomId;

  if (previousRoomId) {
    socket.leave(previousRoomId);
    emitRoomUsers(previousRoomId);
  }

  user.currentRoomId = room.id;
  socket.join(room.id);

  socket.emit("room-joined", getPublicRoom(room, user));
  socket.emit("room-history", await getRoomHistory(room.id));

  io.to(room.id).emit("system-message", `${user.username}已進入聊天室`);
  emitRoomUsers(room.id);
  emitRoomList();
}

async function moveRoomMembersToPublic(room) {
  const memberSocketIds = [...(io.sockets.adapter.rooms.get(room.id) ?? [])];

  for (const socketId of memberSocketIds) {
    const memberSocket = io.sockets.sockets.get(socketId);

    if (!memberSocket) continue;

    memberSocket.emit("room-deleted", {
      roomId: room.id,
      roomName: room.name,
    });
    await joinRoom(memberSocket, "public");
  }
}

async function cleanupExpiredData() {
  const cutoffExpression = `DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${RETENTION_HOURS} HOUR)`;

  await pool.execute(
    `
    DELETE FROM messages
    WHERE room_id = 'public'
      AND created_at < ${cutoffExpression}
    `,
  );

  const [expiredRooms] = await pool.execute(
    `
    SELECT
      rooms.id,
      rooms.name
    FROM rooms
    LEFT JOIN messages ON messages.room_id = rooms.id
    WHERE rooms.id <> 'public'
    GROUP BY rooms.id, rooms.name, rooms.created_at
    HAVING COALESCE(MAX(messages.created_at), rooms.created_at) < ${cutoffExpression}
    `,
  );

  for (const expiredRoom of expiredRooms) {
    const room = rooms.get(expiredRoom.id);

    await pool.execute("DELETE FROM messages WHERE room_id = ?", [
      expiredRoom.id,
    ]);
    await pool.execute("DELETE FROM rooms WHERE id = ?", [expiredRoom.id]);

    if (room) {
      rooms.delete(room.id);
      await moveRoomMembersToPublic(room);
    }
  }

  if (expiredRooms.length > 0) {
    emitRoomList();
  }
}

await cleanupExpiredData();
await loadRooms();
setInterval(() => {
  cleanupExpiredData().catch((error) => {
    console.error("清理過期資料失敗:", error);
  });
}, CLEANUP_INTERVAL_MS);

io.on("connection", (socket) => {
  socket.data.ipAddress = getClientIp(socket);
  socket.emit("room-list", getRoomList(socket.id));

  socket.on("register-user", async (payload, callback) => {
    const username =
      typeof payload === "string" ? payload : String(payload?.username ?? "");
    const cleanName = username.trim().replace(/\s+/g, " ").slice(0, 24);
    const normalizedUsername = normalizeUsername(cleanName);
    const clientUserId = String(payload?.clientUserId ?? "").trim().slice(0, 64);

    if (!cleanName) {
      callback?.({ ok: false, error: "請輸入使用者名稱" });
      return;
    }

    if (isUsernameTaken(normalizedUsername, socket.id)) {
      callback?.({ ok: false, error: "這個暱稱已被使用，請換一個暱稱" });
      return;
    }

    if (!clientUserId) {
      callback?.({ ok: false, error: "無法辨識建立者，請重新整理後再試" });
      return;
    }

    users.set(socket.id, {
      username: cleanName,
      normalizedUsername,
      clientUserId,
      ipAddress: socket.data.ipAddress,
      currentRoomId: "",
    });

    callback?.({ ok: true, userId: socket.id });
    await joinRoom(socket, "public");
  });

  socket.on("create-room", async (payload, callback) => {
    const user = users.get(socket.id);
    const name = String(payload?.name ?? "").trim().replace(/\s+/g, " ");
    const normalizedName = normalizeRoomName(name);
    const password = String(payload?.password ?? "").trim().slice(0, 30);
    const limitEnabled = Boolean(payload?.limitEnabled);
    const requestedMaxUsers = Number(payload?.maxUsers);
    const maxUsers = limitEnabled
      ? requestedMaxUsers
      : DEFAULT_ROOM_MAX_USERS;

    if (!user) {
      callback?.({ ok: false, error: "請先輸入使用者名稱" });
      return;
    }

    if (!name) {
      callback?.({ ok: false, error: "請輸入聊天室名稱" });
      return;
    }

    if (findRoomByName(normalizedName)) {
      callback?.({ ok: false, error: "聊天室名稱已存在，請換一個名稱" });
      return;
    }

    if (findRoomCreatedByIp(user.ipAddress)) {
      callback?.({ ok: false, error: "每個 IP 只能創建一個聊天室" });
      return;
    }

    if (
      !Number.isInteger(maxUsers) ||
      maxUsers < ROOM_MIN_USERS ||
      maxUsers > ROOM_MAX_USERS
    ) {
      callback?.({
        ok: false,
        error: `人數限制必須介於 ${ROOM_MIN_USERS} 到 ${ROOM_MAX_USERS} 人`,
      });
      return;
    }

    const room = {
      id: randomUUID(),
      name,
      normalizedName,
      passwordHash: hashPassword(password),
      creatorClientId: user.clientUserId,
      creatorName: user.username,
      creatorIp: user.ipAddress,
      maxUsers,
      createdAt: new Date(),
    };

    try {
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          room.id,
          room.name,
          room.normalizedName,
          room.passwordHash,
          room.creatorClientId,
          room.creatorName,
          room.creatorIp,
          room.maxUsers,
        ],
      );

      rooms.set(room.id, room);
      emitRoomList();
      await joinRoom(socket, room.id);
      callback?.({ ok: true, room: getPublicRoom(room, user) });
    } catch (error) {
      console.error("建立聊天室失敗:", error);
      callback?.({ ok: false, error: "建立聊天室失敗" });
    }
  });

  socket.on("delete-room", async (payload, callback) => {
    const user = users.get(socket.id);
    const room = rooms.get(String(payload?.roomId ?? ""));

    if (!user) {
      callback?.({ ok: false, error: "請先輸入使用者名稱" });
      return;
    }

    if (!room) {
      callback?.({ ok: false, error: "聊天室不存在" });
      return;
    }

    if (room.id === "public") {
      callback?.({ ok: false, error: "公開聊天室不能刪除" });
      return;
    }

    if (!room.creatorClientId || room.creatorClientId !== user.clientUserId) {
      callback?.({ ok: false, error: "只有建立者可以刪除聊天室" });
      return;
    }

    try {
      await pool.execute("DELETE FROM messages WHERE room_id = ?", [room.id]);
      await pool.execute("DELETE FROM rooms WHERE id = ?", [room.id]);
      rooms.delete(room.id);
      await moveRoomMembersToPublic(room);
      emitRoomList();
      callback?.({ ok: true });
    } catch (error) {
      console.error("刪除聊天室失敗:", error);
      callback?.({ ok: false, error: "刪除聊天室失敗" });
    }
  });

  socket.on("join-room", async (payload, callback) => {
    const user = users.get(socket.id);
    const room = rooms.get(String(payload?.roomId ?? ""));
    const password = String(payload?.password ?? "").trim();

    if (!user) {
      callback?.({ ok: false, error: "請先輸入使用者名稱" });
      return;
    }

    if (!room) {
      callback?.({ ok: false, error: "聊天室不存在" });
      return;
    }

    if (room.passwordHash && room.passwordHash !== hashPassword(password)) {
      callback?.({ ok: false, error: "密碼錯誤" });
      return;
    }

    if (user.currentRoomId !== room.id && getRoomOccupancy(room.id) >= room.maxUsers) {
      callback?.({ ok: false, error: "聊天室人數已滿" });
      return;
    }

    await joinRoom(socket, room.id);
    callback?.({ ok: true, room: getPublicRoom(room, user) });
  });

  socket.on("chat-message", async (message, callback) => {
    const validation = validateOutgoingMessage(socket, message, callback);

    if (!validation) return;

    const { user, text } = validation;
    const id = randomUUID();
    const outgoing = {
      id,
      senderId: socket.id,
      sender: user.username,
      text,
      time: formatTime(),
      isPrivate: false,
    };

    try {
      await pool.execute(
        `
        INSERT INTO messages (
          room_id,
          sender,
          message,
          message_type
        )
        VALUES (?, ?, ?, 'room')
        `,
        [user.currentRoomId, user.username, text],
      );

      io.to(user.currentRoomId).emit("chat-message", outgoing);
      callback?.({ ok: true });
    } catch (error) {
      console.error("MySQL 寫入失敗:", error);
      callback?.({ ok: false, error: "訊息送出失敗" });
    }
  });

  socket.on("private-message", async (payload, callback) => {
    const validation = validateOutgoingMessage(socket, payload, callback);

    if (!validation) return;

    const { user, text } = validation;
    const targetUserId = String(payload?.targetUserId ?? "");
    const targetUser = users.get(targetUserId);

    if (!targetUser || targetUser.currentRoomId !== user.currentRoomId) {
      callback?.({ ok: false, error: "對方已不在這個聊天室" });
      return;
    }

    const id = randomUUID();
    const outgoing = {
      id,
      senderId: socket.id,
      sender: user.username,
      recipientId: targetUserId,
      recipientName: targetUser.username,
      text,
      time: formatTime(),
      isPrivate: true,
    };

    try {
      await pool.execute(
        `
        INSERT INTO messages (
          room_id,
          sender,
          message,
          message_type,
          recipient_socket_id,
          recipient_name
        )
        VALUES (?, ?, ?, 'private', ?, ?)
        `,
        [
          user.currentRoomId,
          user.username,
          text,
          targetUserId,
          targetUser.username,
        ],
      );

      socket.emit("chat-message", outgoing);
      socket.to(targetUserId).emit("chat-message", outgoing);
      callback?.({ ok: true });
    } catch (error) {
      console.error("MySQL 私訊寫入失敗:", error);
      callback?.({ ok: false, error: "私訊送出失敗" });
    }
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    const roomId = user?.currentRoomId;

    users.delete(socket.id);
    emitRoomUsers(roomId);
    emitRoomList();
  });
});

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

httpServer.listen(PORT, HOST, () => {
  console.log(`Server running: http://${HOST}:${PORT}`);
});
