# AGENTS.md

## Ejecutar / verificar

- Instalación para otros usuarios: `./install.sh` (menú Docker/Node, flags `--docker`, `--native`, `--port`).
- Único script: `npm start` (Node 20+, `better-sqlite3` es módulo nativo; `npm install` necesita toolchain de compilación).
- **No hay tests, lint ni typecheck.** Verificación manual: arrancar el server y probar la API con curl, o usar Docker.
- Docker: `docker compose up -d --build` — el puerto publicado es **43590** (no 3000 como dice el README): abrir http://localhost:43590. El contenedor escucha 3000 internamente.
- Sin Docker: `npm start`, puerto configurable con `PORT` (default 3000).

## Arquitectura

- Backend completo en `server.js` (Express + SQLite `better-sqlite3`). Frontend vanilla en `public/` (HTML/CSS/JS sin dependencias ni build step, servido estático). El catch-all `app.get('*')` sirve `public/index.html` (SPA).
- No hay migraciones: el esquema se crea con `CREATE TABLE IF NOT EXISTS` al arrancar. El DB vive en `data/budget.db` (modo WAL); borrar `data/` resetea todo.
- La app y todos los mensajes de UI/API están en **español**; mantener ese idioma en mensajes de error.

## Convenciones críticas del backend

- **Todo es por usuario**: cada endpoint debe filtrar por `req.user.id` (o `user_id` en joins). Las líneas solo se verifican/borran si `user_id` coincide; nunca confiar en el id de la URL.
- Autenticación: cookie HttpOnly `budget_session` (30 días), `scrypt` con salt para contraseñas.
- Regla de negocio: los ajustes **requieren `date`** (validado en el servidor, no solo en el frontend). Los montos aceptan coma decimal (ver `parseAmount`).
- **Los DELETE requieren contraseña**: líneas, ejecuciones y ajustes solo se borran si `req.body.password` verifica contra el hash del usuario (helper `verifyPasswordFor`). Mantener esto en cualquier endpoint nuevo de borrado.
- `foreign_keys = ON`: borrar una línea elimina en cascada sus ejecuciones, ajustes e hijas.
- **Desembolsos**: `executions.disbursement_id` (nullable) agrupa los saldos reales por periodo de financiamiento. Cada desembolso es una pestaña en el frontend; la vista «General» suma todos y las ejecuciones con `disbursement_id` NULL se muestran como «Sin desembolso». `DELETE /api/disbursements/:id` también exige contraseña (`verifyPasswordFor`) y borra sus ejecuciones.
