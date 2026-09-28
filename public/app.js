const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const loginButton = document.getElementById("login");
const registerButton = document.getElementById("register");
const logoutButton = document.getElementById("logout");
const authStatus = document.getElementById("auth-status");

const auth = document.getElementById("auth");
const chat = document.querySelector(".chat");
const welcome = document.querySelector(".welcome");
const accountLabel = document.getElementById("account-label");
const accountLogout = document.getElementById("account-logout");

const input = document.getElementById("message");
const button = document.getElementById("send");
const answer = document.getElementById("answer");

let accessToken = null;
let currentEmail = "";

function showLoggedOut() {
    auth.style.display = "block";
    chat.style.display = "none";
}

function showLoggedIn(email = "") {
    auth.style.display = "none";
    chat.style.display = "flex";

    currentEmail = email || currentEmail;
    accountLabel.textContent = currentEmail || "Вы вошли";
}

function addMessage(role, content, isHtml = false) {
    welcome.style.display = "none";

    const message = document.createElement("div");
    message.className = `message ${role}`;

    if (isHtml) {
        message.innerHTML = DOMPurify.sanitize(
            marked.parse(content)
        );
    } else {
        message.textContent = content;
    }

    answer.appendChild(message);
    message.scrollIntoView({ behavior: "smooth", block: "end" });

    return message;
}

function addStyles() {
    const style = document.createElement("style");

    style.textContent = `
        #answer {
            display: flex;
            flex-direction: column;
            gap: 14px;
            overflow-y: auto;
            max-height: calc(100vh - 270px);
        }

        .message {
            max-width: 78%;
            padding: 14px 17px;
            border-radius: 18px;
            font-size: 14px;
            line-height: 1.55;
        }

        .message.user {
            align-self: flex-end;
            background: #1d1d1b;
            color: #fff;
            border-bottom-right-radius: 6px;
        }

        .message.assistant {
            align-self: flex-start;
            background: #fff;
            border: 1px solid #e8e8e4;
            border-bottom-left-radius: 6px;
        }

        .message.system {
            align-self: center;
            padding: 8px 12px;
            background: transparent;
            color: #777773;
            font-size: 12px;
        }

        .message p {
            margin: 0 0 10px;
        }

        .message p:last-child {
            margin-bottom: 0;
        }

        @media (max-width: 600px) {
            .message {
                max-width: 90%;
            }

            #answer {
                max-height: calc(100vh - 230px);
            }
        }
    `;

    document.head.appendChild(style);
}

addStyles();
showLoggedOut();

async function restoreSession() {
    try {
        const response = await fetch("/api/refresh", {
            method: "POST"
        });

        if (!response.ok) {
            showLoggedOut();
            return;
        }

        const data = await response.json();

        accessToken = data.token;
        authStatus.textContent = "Вы вошли.";
        showLoggedIn();

    } catch (error) {
        console.error("Не удалось восстановить сессию:", error);
        showLoggedOut();
    }
}

restoreSession();

async function refreshAccessToken() {
    const response = await fetch("/api/refresh", {
        method: "POST"
    });

    if (!response.ok) {
        accessToken = null;
        showLoggedOut();
        return false;
    }

    const data = await response.json();
    accessToken = data.token;

    return true;
}

loginButton.addEventListener("click", async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
        authStatus.textContent = "Введите email и пароль.";
        return;
    }

    try {
        const response = await fetch("/api/login", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Ошибка входа");
        }

        accessToken = data.token;
        localStorage.removeItem("sessionId");

        authStatus.textContent = "Вы вошли.";
        passwordInput.value = "";

        answer.innerHTML = "";
        welcome.style.display = "";
        showLoggedIn(email);

    } catch (error) {
        authStatus.textContent = error.message;
    }
});

registerButton.addEventListener("click", async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
        authStatus.textContent = "Введите email и пароль.";
        return;
    }

    try {
        const response = await fetch("/api/register", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Ошибка регистрации");
        }

        authStatus.textContent =
            "Регистрация успешна. Теперь войдите.";

        passwordInput.value = "";

    } catch (error) {
        authStatus.textContent = error.message;
    }
});

async function performLogout() {
    try {
        await fetch("/api/logout", {
            method: "POST"
        });

        accessToken = null;
        currentEmail = "";
        localStorage.removeItem("sessionId");

        answer.innerHTML = "";
        welcome.style.display = "";

        authStatus.textContent = "Вы вышли.";
        showLoggedOut();

    } catch (error) {
        authStatus.textContent = "Ошибка выхода.";
    }
}

logoutButton.addEventListener("click", performLogout);
accountLogout.addEventListener("click", performLogout);

async function sendMessage() {
    if (!accessToken) {
        showLoggedOut();
        return;
    }

    const message = input.value.trim();

    if (!message) {
        return;
    }

    input.value = "";
    addMessage("user", message);

    const thinking = addMessage("system", "AI думает...");
    button.disabled = true;

    let sessionId = localStorage.getItem("sessionId");

    if (!sessionId) {
        sessionId = crypto.randomUUID();
        localStorage.setItem("sessionId", sessionId);
    }

    try {
        let response = await fetch("/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${accessToken}`
            },
            body: JSON.stringify({ message, sessionId })
        });

        if (response.status === 401) {
            const refreshed = await refreshAccessToken();

            if (refreshed) {
                response = await fetch("/api/chat", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${accessToken}`
                    },
                    body: JSON.stringify({ message, sessionId })
                });
            }
        }

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.error || data.answer || "Ошибка сервера"
            );
        }

        thinking.remove();
        addMessage("assistant", data.answer, true);

    } catch (error) {
        console.error("Ошибка:", error);
        thinking.remove();
        addMessage("assistant", error.message);

    } finally {
        button.disabled = false;
        input.focus();
    }
}

button.addEventListener("click", sendMessage);

input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
});
