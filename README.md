# Dashboard de Presupuesto

Aplicación web para gestionar presupuestos con **líneas jerárquicas** (padre/hijo/nieto), registro del **gasto real**, **desembolsos** (periodos de financiamiento) que se reparten entre las líneas y se arrastran al siguiente periodo, y un **dashboard** con filtros.

Pensada para usarse en local: cada usuario tiene sus propios datos y contraseñas con hash. No requiere build ni frameworks en el frontend.

## Características

- **Multiusuario** — registro e inicio de sesión; cada cuenta ve solo sus datos.
- **Líneas de presupuesto jerárquicas** — hasta cualquier nivel. Las líneas hijas se acumulan (roll-up) en el total del padre. Cada línea tiene **código** (podés escribir el tuyo), nombre y monto base.
- **Presupuesto General** — suma de todas las líneas según su jerarquía. Es la base que **no** modifican los desembolsos.
- **Desembolsos (periodos de financiamiento)** — cada uno con nombre, fecha, **monto recibido** y una **meta de ejecución** editable (80% por defecto). Al registrarlo, se reparte el dinero entre las líneas.
- **Reparto / Asignación** — asignás dinero a cualquier nivel (padres, hijos, nietos). Para gastar en una línea, primero tiene que tener dinero asignado en ese desembolso.
- **Saldo real (gasto)** — se registra el monto ejecutado por línea, fecha y desembolso; el dashboard calcula el porcentaje ejecutado.
- **Reserva y arrastre de saldo** — lo que no se repartió queda como reserva y se arrastra solo al siguiente desembolso. Con **«Pasar saldo al siguiente»** además se libera lo repartido y no gastado, y todo queda disponible para repartir en el próximo desembolso.
- **Ajustes de reparto** — movés dinero ya asignado de una línea a otra dentro del mismo desembolso (sin borrar gastos). Queda un registro con origen, destino, monto, nota y la ruta/nivel del origen.
- **Indicador de avance** — en cada desembolso (lista y detalle) se muestra el avance general frente a la meta, con barra de colores y marca en el objetivo.
- **Ajustes de presupuesto** — aumentan o reducen el presupuesto vigente de una línea. **La fecha es obligatoria** (validado en el servidor). Presupuesto vigente = monto base + ajustes.
- **Dashboard General** — KPIs, gráfica de ejecución mensual (área), distribución del gasto (torta interactiva) y árbol de líneas. Filtros por **Año / Mes / Desembolso** que afectan todo el dashboard (no el presupuesto base).
- **Exportar / Importar** — planilla Excel con las hojas: Líneas, Desembolsos, Asignaciones, Saldos reales, Ajustes, Traslados y Saldos trasladados. La importación **agrega** filas (no reemplaza).
- **Ajustes** — moneda del sistema y zona de peligro para **eliminar todos los datos** (con contraseña y aviso).

## Cómo funciona (conceptos)

| Concepto | Qué es |
|---|---|
| **Línea** | Ítem del presupuesto (puede tener hijas). Tiene código, nombre y monto base. |
| **Presupuesto General** | Total del presupuesto por jerarquía. Base que **no** cambian los desembolsos. |
| **Desembolso** | Periodo de financiamiento con un monto recibido. Se **reparte** entre líneas. |
| **Asignación** | Cuánto dinero de un desembolso recibió cada línea. |
| **Gasto (saldo real)** | Lo ejecutado en una línea, con fecha y desembolso. Requiere asignación previa. |
| **Reserva** | Dinero de un desembolso sin repartir; se arrastra al siguiente. |
| **Ajuste de presupuesto** | Suma/resta al presupuesto vigente de una línea (con fecha obligatoria). |

### Navegación (barra lateral)

1. **📊 Dashboard General** — vista global con filtros.
2. **💰 Desembolsos** — lista de desembolsos + detalle del seleccionado (reparto, gasto por mes, ajustes de reparto, saldo al siguiente).
3. **⬇️ Exportar** — descarga la planilla Excel.
4. **⬆️ Importar** — carga una planilla Excel.
5. **⚙️ Ajustes** — moneda y eliminación de datos.

## Inicio rápido

```bash
./install.sh          # menú interactivo (Docker o Node)
./install.sh --docker # Docker Compose (recomendado)
./install.sh --native # Node.js local
./install.sh --port 8080 --native   # cambio de puerto en modo nativo
```

- **Docker:** abrir http://localhost:43590
- **Nativo:** abrir http://localhost:3000

Los datos se guardan en SQLite dentro de `./data` y persisten entre reinicios.

### Manual

```bash
# Docker
docker compose up -d --build
# Node 20+ (better-sqlite3 es un módulo nativo: requiere toolchain de compilación)
npm install && npm start
```

> Cambios en el código: la imagen Docker "hornea" el código, así que hay que reconstruir con `docker compose up -d --build` para verlos.

## Estructura

```
├── server.js            # API + autenticación + SQLite (Express + better-sqlite3)
├── public/              # Frontend (HTML/CSS/JS, sin dependencias ni build)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── Dockerfile
├── docker-compose.yml   # Publica 43590 -> 3000, volumen ./data
├── install.sh           # Instalador (Docker / Node)
└── data/                # Base SQLite (se crea sola; NO se sube a Git)
```

El backend está completo en `server.js`. El esquema se crea al arrancar (`CREATE TABLE IF NOT EXISTS`). No hay migraciones ni tests: la verificación es manual (arrancar y probar con el navegador o `curl`).

## API principal

Todas las rutas salvo `register`/`login` requieren la cookie de sesión. **Los `DELETE` requieren contraseña** en el cuerpo (`{ "password": "..." }`), excepto los traslados.

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/register` | Crear usuario |
| POST | `/api/login` | Iniciar sesión |
| POST | `/api/logout` | Cerrar sesión |
| GET | `/api/me` | Usuario de la sesión |
| GET | `/api/data` | Todo: líneas, saldos reales, ajustes, desembolsos, asignaciones, traslados y saldos trasladados |
| POST | `/api/lines` | Crear línea (`name`, `amount`, `parent_id` opcional, `code` opcional) |
| PUT | `/api/lines/:id` | Editar línea (`name`, `amount`, `code`, `parent_id`) |
| DELETE | `/api/lines/:id` | Eliminar línea en cascada (requiere contraseña) |
| POST | `/api/executions` | Registrar gasto (`line_id`, `date`, `amount`, `note`, `disbursement_id`) |
| DELETE | `/api/executions/:id` | Eliminar gasto (requiere contraseña) |
| POST | `/api/adjustments` | Crear ajuste — **`date` obligatoria** (`line_id`, `date`, `amount`, `note`) |
| DELETE | `/api/adjustments/:id` | Eliminar ajuste (requiere contraseña) |
| POST | `/api/disbursements` | Crear desembolso (`name`, `date`, `amount`, `note`, `target_pct`) |
| PUT | `/api/disbursements/:id` | Editar desembolso (`name`, `date`, `amount`, `note`, `target_pct`) |
| DELETE | `/api/disbursements/:id` | Eliminar desembolso y sus datos (requiere contraseña) |
| POST | `/api/disbursements/:id/release-balance` | Liberar el saldo no gastado y pasarlo al siguiente desembolso (`note`) |
| POST | `/api/allocations` | Asignar dinero a una línea (`disbursement_id`, `line_id`, `amount`) |
| PUT | `/api/allocations/:id` | Editar asignación (`amount`) |
| DELETE | `/api/allocations/:id` | Eliminar asignación (requiere contraseña) |
| POST | `/api/allocations/transfer` | Mover dinero asignado entre líneas (`disbursement_id`, `from_line_id`, `to_line_id`, `amount`, `note`) |
| DELETE | `/api/data` | Eliminar **todos** los datos del usuario (requiere contraseña) |

## Datos y privacidad

- La base vive en `data/budget.db` (modo WAL). **No la subas a Git**: contiene tus datos reales y contraseñas (con hash).
- Borrar la carpeta `data/` reinicia todo.
- Las contraseñas se guardan con hash `scrypt` + salt. La sesión es una cookie HttpOnly `budget_session` (30 días).

## Sin Docker

Requiere Node.js 20+:

```bash
npm install
npm start
```

El puerto se cambia con la variable de entorno `PORT` (por defecto 3000).
