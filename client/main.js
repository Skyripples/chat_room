const socket = io();

const nameModal = document.getElementById("nameModal");
const nameForm = document.getElementById("nameForm");
const nameInput = document.getElementById("nameInput");
const roomModal = document.getElementById("roomModal");
const roomForm = document.getElementById("roomForm");
const roomNameInput = document.getElementById("roomNameInput");
const roomPasswordInput = document.getElementById("roomPasswordInput");
const cancelRoomButton = document.getElementById("cancelRoomButton");
const createRoomButton = document.getElementById("createRoomButton");
const roomList = document.getElementById("roomList");
const roomTitle = document.getElementById("roomTitle");
const roomStatus = document.getElementById("roomStatus");
const messageList = document.getElementById("messageList");
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const privateBar = document.getElementById("privateBar");
const privateTargetText = document.getElementById("privateTargetText");
const clearPrivateButton = document.getElementById("clearPrivateButton");
const memberList = document.getElementById("memberList");
const memberCount = document.getElementById("memberCount");

let username = "";
let selfId = "";
let currentRoomId = "";
let rooms = [];
let roomUsers = [];
let privateTarget = null;

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setInputEnabled(enabled) {
  messageInput.disabled = !enabled;
  sendButton.disabled = !enabled;
}

function updateReadyState() {
  const hasName = username.length > 0;
  const hasRoom = currentRoomId.length > 0;

  if (!socket.connected) {
    roomStatus.textContent = "連線中...";
  } else if (!hasName) {
    roomStatus.textContent = "請先輸入暱稱";
  } else if (!hasRoom) {
    roomStatus.textContent = "請選擇聊天室";
  } else {
    const room = rooms.find((item) => item.id === currentRoomId);
    const count = room?.userCount ?? 0;

    roomStatus.textContent = `${count} 人在線`;
  }

  setInputEnabled(socket.connected && hasName && hasRoom);
}

function setPrivateTarget(user) {
  privateTarget = user;

  if (!privateTarget) {
    privateBar.classList.add("hidden");
    messageInput.placeholder = "輸入訊息...";
    return;
  }

  privateTargetText.textContent = `正在私訊 ${privateTarget.username}`;
  privateBar.classList.remove("hidden");
  messageInput.placeholder = `私訊 ${privateTarget.username}...`;
  messageInput.focus();
}

function appendSystemMessage(text) {
  const row = document.createElement("div");

  row.className = "system-message";
  row.textContent = text;

  messageList.appendChild(row);
  messageList.scrollTop = messageList.scrollHeight;
}

function appendMessage(message) {
  if (!message.text) return;

  const isMe = message.senderId === selfId || message.sender === username;
  const row = document.createElement("div");
  const privateLabel = message.isPrivate
    ? `<div class="private-label">${
        isMe
          ? `私訊給 ${escapeHtml(message.recipientName)}`
          : `${escapeHtml(message.sender)} 私訊你`
      }</div>`
    : "";

  row.className = `message-row ${isMe ? "me" : "other"} ${
    message.isPrivate ? "private" : ""
  }`;
  row.innerHTML = `
    <div class="message-bubble">
      ${privateLabel}
      <div><strong>${escapeHtml(message.sender)}</strong></div>
      <div>${escapeHtml(message.text)}</div>
      <div class="message-time">${escapeHtml(message.time)}</div>
    </div>
  `;

  messageList.appendChild(row);
  messageList.scrollTop = messageList.scrollHeight;
}

function renderRooms() {
  roomList.innerHTML = "";

  rooms.forEach((room) => {
    const button = document.createElement("button");
    const label = room.name.slice(0, 1) || "聊";

    button.type = "button";
    button.className = `room-item ${room.id === currentRoomId ? "active" : ""}`;
    button.innerHTML = `
      <span class="avatar">${escapeHtml(label)}</span>
      <span class="room-info">
        <span class="room-name">${escapeHtml(room.name)}</span>
        <span class="room-meta">${room.isPrivate ? "私人聊天室" : "公開聊天室"} · ${room.userCount} 人</span>
      </span>
    `;

    button.addEventListener("click", () => {
      if (room.id === currentRoomId) return;

      let password = "";

      if (room.isPrivate) {
        password = window.prompt(`請輸入「${room.name}」的密碼`) ?? "";
      }

      socket.emit("join-room", { roomId: room.id, password }, (response) => {
        if (!response?.ok) {
          window.alert(response?.error ?? "無法加入聊天室");
        }
      });
    });

    roomList.appendChild(button);
  });
}

function renderMembers() {
  memberList.innerHTML = "";
  memberCount.textContent = `${roomUsers.length} 人在線`;

  roomUsers.forEach((user) => {
    const isSelf = user.id === selfId;
    const button = document.createElement("button");

    button.type = "button";
    button.className = `member-item ${isSelf ? "self" : ""} ${
      privateTarget?.id === user.id ? "active" : ""
    }`;
    button.disabled = isSelf;
    button.innerHTML = `
      <span class="member-avatar">${escapeHtml(user.username.slice(0, 1) || "匿")}</span>
      <span class="member-name">${escapeHtml(user.username)}${isSelf ? "（你）" : ""}</span>
      <span class="member-action">${isSelf ? "" : "私訊"}</span>
    `;

    button.addEventListener("click", () => {
      setPrivateTarget(user);
      renderMembers();
    });

    memberList.appendChild(button);
  });
}

nameForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const value = nameInput.value.trim();

  if (!value) return;

  socket.emit("register-user", value, (response) => {
    if (!response?.ok) {
      window.alert(response?.error ?? "無法進入聊天室");
      return;
    }

    username = value;
    selfId = response.userId;
    nameModal.classList.add("hidden");
    updateReadyState();
    messageInput.focus();
  });
});

createRoomButton.addEventListener("click", () => {
  if (!username) {
    window.alert("請先輸入暱稱");
    return;
  }

  roomForm.reset();
  roomModal.classList.remove("hidden");
  roomNameInput.focus();
});

cancelRoomButton.addEventListener("click", () => {
  roomModal.classList.add("hidden");
});

roomForm.addEventListener("submit", (event) => {
  event.preventDefault();

  socket.emit(
    "create-room",
    {
      name: roomNameInput.value.trim(),
      password: roomPasswordInput.value.trim(),
    },
    (response) => {
      if (!response?.ok) {
        window.alert(response?.error ?? "無法建立聊天室");
        return;
      }

      roomModal.classList.add("hidden");
      messageInput.focus();
    },
  );
});

clearPrivateButton.addEventListener("click", () => {
  setPrivateTarget(null);
  renderMembers();
});

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const text = messageInput.value.trim();

  if (!text || !username || !socket.connected || !currentRoomId) return;

  if (privateTarget) {
    socket.emit(
      "private-message",
      {
        targetUserId: privateTarget.id,
        text,
      },
      (response) => {
        if (!response?.ok) {
          window.alert(response?.error ?? "私訊送出失敗");
          setPrivateTarget(null);
          renderMembers();
        }
      },
    );
  } else {
    socket.emit("chat-message", { text });
  }

  messageInput.value = "";
  messageInput.focus();
});

socket.on("connect", () => {
  updateReadyState();
});

socket.on("disconnect", () => {
  setInputEnabled(false);
  roomStatus.textContent = "連線中斷，重新連線中...";
});

socket.on("room-list", (nextRooms) => {
  rooms = nextRooms;
  renderRooms();
  updateReadyState();
});

socket.on("room-joined", (room) => {
  currentRoomId = room.id;
  roomTitle.textContent = room.name;
  messageList.innerHTML = "";
  setPrivateTarget(null);
  renderRooms();
  updateReadyState();
});

socket.on("room-history", (messages) => {
  messageList.innerHTML = "";
  messages.forEach(appendMessage);
});

socket.on("room-users", (users) => {
  roomUsers = users;

  if (privateTarget && !roomUsers.some((user) => user.id === privateTarget.id)) {
    setPrivateTarget(null);
  }

  renderMembers();
  updateReadyState();
});

socket.on("system-message", (text) => {
  appendSystemMessage(text);
});

socket.on("chat-message", (message) => {
  appendMessage(message);
});

updateReadyState();
nameInput.focus();
