/**
 * Конфигурация прототипа.
 *
 * Чтобы заявки уходили в реальную HR-систему, укажите URL вебхука.
 * Форма отправит multipart/form-data: name, phone, email, city, resumeLink,
 * consent, vacancy, charId и файл резюме (если он выбран).
 *
 * Пример:
 * applyEndpoint: "https://hr.example.com/api/ochakovo/apply"
 *
 * Если оставить пустым, форма работает в демо-режиме и сохраняет заявку
 * только в localStorage браузера.
 */
window.BRODILKA_CONFIG = {
  applyEndpoint: ""
};
