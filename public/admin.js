const productsContainer = document.getElementById("products");
const messageElement = document.getElementById("message");
const addProductButton = document.getElementById("addProductButton");
const addProductForm = document.getElementById("addProductForm");
const createProductButton = document.getElementById("createProductButton");

const newProductName = document.getElementById("newProductName");
const newProductCategory = document.getElementById("newProductCategory");
const newProductPrice = document.getElementById("newProductPrice");
const newProductCurrency = document.getElementById("newProductCurrency");
const newProductStock = document.getElementById("newProductStock");
function getToken() {
    return localStorage.getItem("accessToken");
}

function setMessage(text) {
    messageElement.textContent = text;

    if (text) {
        setTimeout(() => {
            if (messageElement.textContent === text) {
                messageElement.textContent = "";
            }
        }, 3000);
    }
}

async function refreshAccessToken() {
    const response = await fetch("/api/refresh", {
        method: "POST",
        credentials: "include"
    });

    if (!response.ok) {
        localStorage.removeItem("accessToken");
        window.location.href = "/";
        return null;
    }

    const data = await response.json();

    localStorage.setItem("accessToken", data.token);

    return data.token;
}

async function apiRequest(url, options = {}) {
    let token = getToken();

    if (!token) {
        token = await refreshAccessToken();

        if (!token) {
            return null;
        }
    }

    const request = {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...options.headers,
            Authorization: `Bearer ${token}`
        }
    };

    let response = await fetch(url, request);

    if (response.status === 401) {
        token = await refreshAccessToken();

        if (!token) {
            return null;
        }

        request.headers.Authorization = `Bearer ${token}`;
        response = await fetch(url, request);
    }

    if (response.status === 403) {
        productsContainer.innerHTML = `
            <div class="empty">
                У этой учётной записи нет доступа к админ-панели.
            </div>
        `;

        throw new Error("FORBIDDEN");
    }

    return response;
}

function renderProducts(products) {
    if (!products.length) {
        productsContainer.innerHTML = `
            <div class="empty">
                В каталоге пока нет товаров.
            </div>
        `;
        return;
    }

    productsContainer.innerHTML = "";

    for (const product of products) {
        const element = document.createElement("div");
        element.className = "product";

        const info = document.createElement("div");
        info.className = "product-info";

        const name = document.createElement("div");
        name.className = "product-name";
        name.textContent = product.name;

        const category = document.createElement("div");
        category.className = "category";
        category.textContent = product.category || "other";

        info.append(name, category);

        const priceField = document.createElement("div");
        priceField.className = "field";

        const priceLabel = document.createElement("label");
        priceLabel.textContent = `Цена · ${product.currency}`;

        const priceInput = document.createElement("input");
        priceInput.type = "number";
        priceInput.min = "0";
        priceInput.step = "0.01";
        priceInput.value = product.price;
        priceInput.disabled = true;

        priceField.append(priceLabel, priceInput);

        const stockField = document.createElement("div");
        stockField.className = "field";

        const stockLabel = document.createElement("label");
        stockLabel.textContent = "Остаток";

        const stockInput = document.createElement("input");
        stockInput.type = "number";
        stockInput.min = "0";
        stockInput.step = "1";
        stockInput.value = product.stock;
        stockInput.disabled = true;

        stockField.append(stockLabel, stockInput);

        const saveButton = document.createElement("button");
        saveButton.textContent = "Редактировать";

        const cancelButton = document.createElement("button");
        cancelButton.textContent = "Отмена";
        cancelButton.hidden = true;

        const deleteButton = document.createElement("button");
        deleteButton.textContent = "Удалить";
        deleteButton.type = "button";

        const actions = document.createElement("div");
        actions.className = "product-actions";

        actions.append(saveButton, cancelButton, deleteButton);

        saveButton.addEventListener("click", async () => {
            if (priceInput.disabled) {
                priceInput.disabled = false;
                stockInput.disabled = false;
                cancelButton.hidden = false;

                saveButton.textContent = "Сохранить";
                priceInput.focus();

                return;
            }

            saveButton.disabled = true;
            saveButton.textContent = "Сохраняю…";

            try {
                const response = await apiRequest(
                    `/api/admin/products/${product.id}`,
                    {
                        method: "PATCH",
                        body: JSON.stringify({
                            price: Number(priceInput.value),
                            stock: Number(stockInput.value)
                        })
                    }
                );

                if (!response) {
                    return;
                }

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(
                        data.error || "Не удалось сохранить товар."
                    );
                }

                priceInput.value = data.product.price;
                stockInput.value = data.product.stock;
                product.price = data.product.price;
                product.stock = data.product.stock;
                priceInput.disabled = true;
                stockInput.disabled = true;
                cancelButton.hidden = true;

                setMessage(`${product.name} сохранён.`);

            } catch (error) {
                if (error.message !== "FORBIDDEN") {
                    setMessage(error.message);
                }
            } finally {
                saveButton.disabled = false;

                if (priceInput.disabled) {
                    saveButton.textContent = "Редактировать";
                } else {
                    saveButton.textContent = "Сохранить";
                }
            }
        });

        cancelButton.addEventListener("click", () => {
            priceInput.value = product.price;
            stockInput.value = product.stock;

            priceInput.disabled = true;
            stockInput.disabled = true;

            saveButton.textContent = "Редактировать";
            cancelButton.hidden = true;
        });

        deleteButton.addEventListener("click", async () => {
            const confirmed = confirm(
                `Удалить товар «${product.name}»?`
            );

            if (!confirmed) {
                return;
            }

            try {
                deleteButton.disabled = true;

                const response = await apiRequest(
                    `/api/admin/products/${product.id}`,
                    {
                        method: "DELETE"
                    }
                );

                if (!response) {
                    return;
                }

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(
                        data.error || "Не удалось удалить товар."
                    );
                }

                element.remove();

                setMessage(`${product.name} удалён.`);

            } catch (error) {
                setMessage(error.message);
                deleteButton.disabled = false;
            }
        });

        element.append(
            info,
            priceField,
            stockField,
            actions
        );

        productsContainer.appendChild(element);
    }
}

async function loadProducts() {
    try {
        const response = await apiRequest("/api/admin/products");

        if (!response) {
            return;
        }

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.error || "Не удалось загрузить товары."
            );
        }

        renderProducts(data.products);

    } catch (error) {
        if (error.message !== "FORBIDDEN") {
            productsContainer.innerHTML = `
                <div class="empty">
                    Не удалось загрузить товары.
                </div>
            `;

            setMessage(error.message);
        }
    }
}
addProductButton.addEventListener("click", () => {
    addProductForm.hidden = !addProductForm.hidden;

    addProductButton.textContent = addProductForm.hidden
        ? "+ Добавить товар"
        : "Отмена";

    if (!addProductForm.hidden) {
        newProductName.focus();
    }
});

createProductButton.addEventListener("click", async () => {
    const name = newProductName.value.trim();
    const category = newProductCategory.value;
    const price = Number(newProductPrice.value);
    const currency = newProductCurrency.value.trim().toUpperCase();
    const stock = Number(newProductStock.value);

    if (!name) {
        setMessage("Укажите название товара.");
        return;
    }

    if (!Number.isFinite(price) || price < 0) {
        setMessage("Укажите корректную цену.");
        return;
    }

    if (!currency) {
        setMessage("Укажите валюту.");
        return;
    }

    if (!Number.isInteger(stock) || stock < 0) {
        setMessage("Укажите корректный остаток.");
        return;
    }

    createProductButton.disabled = true;
    createProductButton.textContent = "Добавляю…";

    try {
        const response = await apiRequest("/api/admin/products", {
            method: "POST",
            body: JSON.stringify({
                name,
                category,
                price,
                currency,
                stock
            })
        });

        if (!response) {
            return;
        }

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.error || "Не удалось добавить товар."
            );
        }

        newProductName.value = "";
        newProductCategory.value = "phone";
        newProductPrice.value = "";
        newProductCurrency.value = "EUR";
        newProductStock.value = "";

        addProductForm.hidden = true;
        addProductButton.textContent = "+ Добавить товар";

        setMessage(`${data.product.name} добавлен.`);

        await loadProducts();

    } catch (error) {
        setMessage(error.message);
    } finally {
        createProductButton.disabled = false;
        createProductButton.textContent = "Добавить";
    }
});
loadProducts();