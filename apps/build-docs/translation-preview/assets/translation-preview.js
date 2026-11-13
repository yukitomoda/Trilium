const toggle = document.querySelector('#translation-toggle');
const content = document.querySelector('#translation-body');
const status = document.querySelector('#translation-status');
const originalTemplate = document.querySelector('#translation-original');
const title = document.querySelector('#title');
if (toggle && content && status && originalTemplate) {
    const translatedHtml = content.innerHTML;
    const translatedStatus = status.textContent;
    const translatedLanguage = content.lang || 'en';
    toggle.hidden = false;
    toggle.addEventListener('click', () => {
        const original = toggle.getAttribute('aria-pressed') !== 'true';
        toggle.setAttribute('aria-pressed', String(original));
        toggle.textContent = original ? '訳文表示に戻る' : '英語原文を表示';
        status.textContent = original
            ? '翻訳元コミットの英語原文を表示中です。最新の内容は公式サイトで確認してください。'
            : translatedStatus;
        content.dataset.view = original ? 'original' : 'translation';
        content.innerHTML = original ? originalTemplate.innerHTML : translatedHtml;
        content.lang = original ? 'en' : translatedLanguage;
        if (title && content.dataset.originalTitle) {
            title.textContent = original
                ? content.dataset.originalTitle : content.dataset.translatedTitle;
            title.lang = original ? 'en' : translatedLanguage;
        }
    });
}
