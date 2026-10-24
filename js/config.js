/**
 * Конфигурация прототипа.
 *
 * По умолчанию карточки уходят в локальный сервер (serve.js):
 * POST /api/applications. Там же лежит скрытая админка /admin.
 *
 * Если поставить пустую строку, форма снова станет полностью локальной:
 * заявка сохранится только в localStorage браузера.
 *
 * Для внешней HR-системы укажите её URL. Форма отправит JSON:
 * name (ФИО), birthDate, education, phone, email, city, resumeLink,
 * consent, vacancy, charId, source.
 */
window.BRODILKA_CONFIG = {
  applyEndpoint: "/api/applications"
};
