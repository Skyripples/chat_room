import pool, { initDatabase } from "./db.js";
import express from "express";
import { createServer } from "http";
import { createHash, randomUUID } from "crypto";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

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

function getPublicRoom(room, user) {
  return {
    id: room.id,
    name: room.name,
    isPrivate: Boolean(room.passwordHash),
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

async function loadRooms() {
  const [rows] = await pool.execute(
    `
    SELECT
      id,
      name,
      password_hash AS passwordHash,
      creator_client_id AS creatorClientId,
      creator_name AS creatorName,
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
      passwordHash: room.passwordHash,
      creatorClientId: room.creatorClientId,
      creatorName: room.creatorName,
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

await loadRooms();

io.on("connection", (socket) => {
  socket.emit("room-list", getRoomList(socket.id));

  socket.on("register-user", async (payload, callback) => {
    const username =
      typeof payload === "string" ? payload : String(payload?.username ?? "");
    const cleanName = username.trim().slice(0, 24);
    const clientUserId = String(payload?.clientUserId ?? "").trim().slice(0, 64);

    if (!cleanName) {
      callback?.({ ok: false, error: "請輸入使用者名稱" });
      return;
    }

    if (!clientUserId) {
      callback?.({ ok: false, error: "無法辨識建立者，請重新整理後再試" });
      return;
    }

    users.set(socket.id, {
      username: cleanName,
      clientUserId,
      currentRoomId: "",
    });

    callback?.({ ok: true, userId: socket.id });
    await joinRoom(socket, "public");
  });

  socket.on("create-room", async (payload, callback) => {
    const user = users.get(socket.id);
    const name = String(payload?.name ?? "").trim().slice(0, 60);
    const password = String(payload?.password ?? "").trim().slice(0, 30);

    if (!user) {
      callback?.({ ok: false, error: "請先輸入使用者名稱" });
      return;
    }

    if (!name) {
      callback?.({ ok: false, error: "請輸入聊天室名稱" });
      return;
    }

    const room = {
      id: randomUUID(),
      name,
      passwordHash: hashPassword(password),
      creatorClientId: user.clientUserId,
      creatorName: user.username,
      createdAt: new Date(),
    };

    try {
      await pool.execute(
        `
        INSERT INTO rooms (
          id,
          name,
          password_hash,
          creator_client_id,
          creator_name
        )
        VALUES (?, ?, ?, ?, ?)
        `,
        [
          room.id,
          room.name,
          room.passwordHash,
          room.creatorClientId,
          room.creatorName,
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

    await joinRoom(socket, room.id);
    callback?.({ ok: true, room: getPublicRoom(room, user) });
  });

  socket.on("chat-message", async (message) => {
    const user = users.get(socket.id);
    const text = String(message?.text ?? "").trim().slice(0, 500);

    if (!user?.currentRoomId || !text) return;

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
    } catch (error) {
      console.error("MySQL 寫入失敗:", error);
    }
  });

  socket.on("private-message", async (payload, callback) => {
    const user = users.get(socket.id);
    const text = String(payload?.text ?? "").trim().slice(0, 500);
    const targetUserId = String(payload?.targetUserId ?? "");
    const targetUser = users.get(targetUserId);

    if (!user?.currentRoomId || !text) return;

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
