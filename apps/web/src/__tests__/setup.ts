import '@testing-library/jest-dom';
import '@/lib/i18n';

// jsdom has no scrolling implementation.
window.scrollTo = () => {};
