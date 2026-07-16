'use strict';

const { Hono } = require('hono');

module.exports = {
  register(registrar) {
    const routes = new Hono();
    routes.get('/health', (context) => context.json({ ok: true, fixture: 'sdk-v1-minimal' }));
    registrar.mountRoute(routes);
  },
};
