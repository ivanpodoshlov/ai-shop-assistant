const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const loginButton = document.getElementById("login");
const registerButton = document.getElementById("register");
const logoutButton = document.getElementById("logout");
const authStatus = document.getElementById("auth-status");

let accessToken = null;

async function restoreSession() {
    try {
        const response = await fetch("/api/refresh", {
            method: "POST"
        });

        if (!response.ok) {
            return;
        }

        const data = await response.json();

        accessToken = data.token;
        authStatus.textContent = "Вы вошли.";

    } catch (error) {
        console.error("Не удалось восстановить сессию:", error);
    }
}

restoreSession();

async function refreshAccessToken() {
    const response = await fetch("/api/refresh", {
        method: "POST"
    });

    if (!response.ok) {
        accessToken = null;
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
logoutButton.addEventListener("click", async () => {
    try {
        await fetch("/api/logout", {
            method: "POST"
        });

        accessToken = null;
        localStorage.removeItem("sessionId");

        authStatus.textContent = "Вы вышли.";

    } catch (error) {
        authStatus.textContent = "Ошибка выхода.";
    }
});
const input = document.getElementById("message");
const button = document.getElementById("send");
const answer = document.getElementById("answer");

button.addEventListener("click", async () => {
    if (!accessToken) {
        answer.textContent = "Сначала войдите в аккаунт.";
        return;
    }
    const message = input.value.trim();

    if (!message) {
        answer.textContent = "Введите сообщение.";
        return;
    }

    input.value = "";
    answer.textContent = "AI думает...";
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
            throw new Error(data.error || data.answer || "Ошибка сервера");
        }
        answer.innerHTML = DOMPurify.sanitize(
            marked.parse(data.answer)
        );
    } catch (error) {
        console.error("Ошибка:", error);
        answer.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});