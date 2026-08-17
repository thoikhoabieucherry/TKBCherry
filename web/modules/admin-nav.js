/* Admin page navigation — tách khỏi app.js để dễ bảo trì */
function loadPage(name) {
    const container = document.getElementById("section-content");
    if (!container) return console.error("Không tìm thấy #section-content");

    try{
        document.querySelectorAll('.app-nav .btn[data-page]').forEach(b=>{
            b.classList.toggle('nav-active', (b.dataset.page || '') === name);
        });
    }catch(_){ /* ignore */ }

    if (name === "pccm") {
        pccmRenderCurrent(container, { skipRemember: true });
        return;
    }

    if (name === "mon") {
        renderSectionInto("monhoc", "section-content", document);
        return;
    }

    if (name === "tietchuan") {
        tcResetSelection();
        container.innerHTML = renderTietChuanPage();
        return;
    }

    renderSectionInto(name, "section-content", document);
}
