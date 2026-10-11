# Arquitectura — Sistema de Gestión Clínica Local-First

> ** stack: Go + PocketBase embebido + Wails (Desktop) + Flutter (Mobile)**
> ** enfoque: local-first, sync eventual, marca blanca por clínica**

---

## 1. Visión de Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│                        CLÍNICA A                            │
│  ┌──────────────┐          ┌──────────────────────────┐   │
│  │ Wails        │◄────────►│ PocketBase Go embebido   │   │
│  │ Desktop App  │  IPC     │ + SQLite WAL             │   │
│  └──────┬───────┘          └───────────┬──────────────┘   │
│         │                                  │                │
│  ┌──────▼───────┐              ┌─────────▼──────────┐      │
│  │ Flutter      │◄────────────►│ Worker Sync (Go)   │      │
│  │ Mobile App   │  REST/SSE   │ + Outbox Table     │      │
│  │ (Drift cache)│              └─────────┬──────────┘      │
│  └──────────────┘                        │                 │
└──────────────────────────────────────────┼─────────────────┘
                                           │ TLS/gRPC
                                    ┌──────▼───────┐
                                    │ VPS PocketBase│
                                    │ (consolidado) │
                                    └──────┬───────┘
                                           │
                          ┌────────────────┼────────────────┐
                          │                │                │
                   ┌──────▼────┐   ┌──────▼────┐   ┌──────▼────┐
                   │ CLÍNICA B │   │ CLÍNICA C │   │ BACKUP    │
                   │ (sucursal)│   │ (tercero) │   │ POINT     │
                   └───────────┘   └───────────┘   └───────────┘
```

**Principios rectores:**

1. **Local-first absoluto:** toda operación funciona sin internet. La sync es un bonus, no un requisito.
2. **Conflictos deterministas:** nunca hay ambigüedad sobre quién gana. La regla depende del tipo de dato.
3. **Marca blanca como primera clase:** cada clínica tiene su identidad visual, roles y flujo, sin que el código sepa de clínica.
4. **Mobile es un subset, no un mirror:** Flutter tiene los pacientes asignados al profesional, no la base completa.

---

## 2. Stack Tecnológico

| Capa | Tecnología | Rol |
|---|---|---|
| Core engine | Go 1.22+ | Lógica de negocio, hooks, sync worker, bindings nativos |
| DB + Auth local | PocketBase SDK embebido | SQLite WAL, API reactiva, auth JWT local |
| DB + Auth remote | PocketBase (VPS) | Consolidación multi-sucursal, backup |
| Cliente Desktop | Wails v2 | Binario nativo, bindings Go→UI directos, biometría SO |
| Cliente Mobile | Flutter 3.x | Shell nativo, Drift (cache local), biometría device |
| Sincronización | Go worker + REST/SSE | Outbox pattern, backoff exponencial |
| Landing builder | Go templates + go-git | SSG, deploy a GitHub Pages |
| Credenciales | SO Keychain / Flutter SecureStorage | Tokens GitHub, secretos de sync |

---

## 3. Modelo de Datos — Esquema de Control de Sincronización

Toda colección PocketBase hereda estos campos de control:

```sql
-- Metadatos de sync en TODA coleccion
ALTER TABLE <tabla> ADD COLUMN _client_id   TEXT NOT NULL;  -- UUID del nodo que creo el registro
ALTER TABLE <tabla> ADD COLUMN _client_seq  INTEGER NOT NULL DEFAULT 0;  -- secuencial monotono por nodo
ALTER TABLE <tabla> ADD COLUMN _deleted_at  TEXT;            -- ISO8601 si fue eliminado (soft delete)
ALTER TABLE <tabla> ADD COLUMN _vector_ts   TEXT NOT NULL;  -- ISO8601 microsegundos UTC
```

**Regla de IDs:** todos los IDs son UUID v4 generados en el cliente antes de INSERT. Esto evita colisiones entre nodos que usan AUTOINCREMENT.

**Regla de timestamps:** `updated_at` se mantiene por PocketBase. `_vector_ts` es el timestamp del nodo emisor, usado para LWW en conflictos de texto.

### 3.1 Colecciones Core

```
users
├── id              (UUID v4, client-generated)
├── email
├── password_hash   (bcrypt, local)
├── role_id         → roles.id
├── clinic_id       → clinics.id
├── device_token    (para notificaciones push)
├── _client_id / _client_seq / _deleted_at / _vector_ts

roles
├── id
├── clinic_id       → clinics.id
├── name            ("Administrador", "Médico", "Recepción"...)
├── permissions     (JSON: { "patients.create": true, ... })
├── is_system       (bool: true = rol base, no se puede eliminar)
├── priority        (int: para desempate en herencia)
├── _client_id / _client_seq / _deleted_at / _vector_ts

clinics
├── id
├── name
├── slug            (subdominio / identificador unico)
├── branding        (JSON: { primary_color, secondary_color, logo_url, font_family })
├── tax_id          (CUIT/RUT/NIT)
├── address
├── phone / email
├── landing_config  (JSON: estado del constructor visual)
├── _client_id / _client_seq / _deleted_at / _vector_ts

patients
├── id
├── clinic_id
├── assigned_user_ids (ARRAY de user.id -- varios profesionales pueden verlo)
├── first_name / last_name
├── document_id
├── birth_date
├── phone / email / whatsapp
├── emergency_contact
├── notes
├── _client_id / _client_seq / _deleted_at / _vector_ts

appointments
├── id
├── patient_id
├── user_id          (profesional asignado)
├── clinic_id
├── scheduled_at      (ISO8601)
├── status            ("scheduled" | "confirmed" | "in_progress" | "completed" | "cancelled" | "no_show")
├── plan_id           → plans.id (si es una sesion de un plan)
├── plan_ledger_id    (para marcar qué ledger-entry consumio)
├── notes
├── _client_id / _client_seq / _deleted_at / _vector_ts

plans                      -- Maestro del plan
├── id
├── patient_id
├── clinic_id
├── name                ("Paquete 10 sesiones")
├── total_sessions      (int, nunca se modifica)
├── price
├── status              ("active" | "exhausted" | "cancelled")
├── _client_id / _client_seq / _deleted_at / _vector_ts

plan_ledger                -- LOG APPEND-ONLY de movimientos
├── id
├── plan_id                → plans.id
├── clinic_id
├── user_id                (profesional que ejecuta)
├── appointment_id         → appointments.id (nullable)
├── type                   ("purchase" | "consumption" | "cancellation" | "refund" | "adjustment")
├── sessions_delta          (+N para purchase, -1 para consumption...)
├── balance_after          (int: sessions restantes tras este movimiento)
├── reason
├── created_at             (timestamp del evento, inmutable)
├── _client_id / _client_seq / _deleted_at / _vector_ts
-- NOTE: UNIQUE constraint en (plan_id, id) -- no hay updates, solo inserts

patient_records            -- Entrada de historial clínico
├── id
├── patient_id
├── clinic_id
├── user_id                (profesional autor)
├── record_type            ("note" | "study" | "anatomy" | "evolution")
├── content                (texto / notas clinicas)
├── attachments            (ARRAY de file IDs -- imagenes, DICOM refs)
├── anatomy_markers        (JSON: [{ "region": "lumbar", "side": "left", "level": "L4-L5", "pain": 7, "date": "..." }])
├── _client_id / _client_seq / _deleted_at / _vector_ts

cash_sessions              -- Sesion de caja (apertura/arqueo/cierre)
├── id
├── clinic_id
├── user_id                (responsable de caja)
├── opened_at
├── closed_at
├── opening_balance        (float)
├── closing_balance        (float)
├── status                 ("open" | "closed" | "reconciled")
├── _client_id / _client_seq / _deleted_at / _vector_ts

cash_movements             -- Movimientos dentro de una sesion de caja
├── id
├── cash_session_id
├── type                   ("income" | "expense")
├── method                 ("cash" | "transfer" | "card" | "plan_redemption")
├── amount
├── reference_id           (appointment_id / plan_ledger_id si aplica)
├── description
├── _client_id / _client_seq / _deleted_at / _vector_ts

notifications              -- Cola de notificaciones a enviar
├── id
├── patient_id             (nullable -- puede ser para user)
├── user_id                (nullable)
├── channel                ("email" | "whatsapp" | "push")
├── template_id
├── payload                (JSON: datos del template)
├── status                 ("pending" | "sent" | "failed")
├── scheduled_at
├── sent_at
├── _client_id / _client_seq / _deleted_at / _vector_ts

_outbox                    -- Cola de replicación saliente (NO es una coleccion visible)
├── id
├── source_table
├── source_id
├── operation              ("create" | "update" | "delete")
├── payload                (JSON del registro completo)
├── vector_ts
├── client_id
├── client_seq
├── synced                 (bool: false = pendiente)
├── synced_at
```

---

## 4. Sincronización — Worker de Réplica

### 4.1 Arquitectura del Worker

```
┌─────────────────────────────────────────────┐
│ PocketBase Local (Go embebido)             │
│                                             │
│  [HOOK: OnModelAfter*] ──► _outbox table   │
│                                             │
│              ▲                              │
│              │                             │
│  ┌───────────┼─────────────────────────┐  │
│  │ Sync Worker (goroutine background)  │  │
│  │                                   │  │
│  │  1. SELECT * FROM _outbox        │  │
│  │     WHERE synced = false           │  │
│  │     ORDER BY vector_ts ASC         │  │
│  │     LIMIT 50                       │  │
│  │                                   │  │
│  │  2. POST /api/sync/push            │  │
│  │     { events: [...] }              │  │
│  │     to VPS PocketBase              │  │
│  │                                   │  │
│  │  3. On 200: UPDATE _outbox         │  │
│  │     SET synced = true,             │  │
│  │         synced_at = now()           │  │
│  │     WHERE id = ?                   │  │
│  │                                   │  │
│  │  4. On network error:             │  │
│  │     exponential backoff            │  │
│  │     (1s → 2s → 4s → 30s → 5min)  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
                    │
                    │ TLS
                    ▼
┌─────────────────────────────────────────┐
│ VPS PocketBase                          │
│                                         │
│ POST /api/sync/push                     │
│   Body: { events: [...], client_id }    │
│                                         │
│ 1. For each event:                      │
│    - Lookup remote record by (table, id)│
│    - Apply conflict resolution          │
│    - UPSERT into local PocketBase       │
│                                         │
│ 2. Response:                           │
│    { applied: 45, conflicts: 2,         │
│      conflict_details: [...] }           │
│                                         │
│ SSE /api/sync/pull?since=<vector_ts>   │
│   → transmite cambios de otros nodos    │
└─────────────────────────────────────────┘
```

### 4.2 Resolución de Conflictos por Tipo de Dato

| Tipo de Dato | Estrategia | Implementación |
|---|---|---|
| **Citas / Sesiones** | Append-only events | `plan_ledger` es inmutable. La cita referencia una ledger-entry. Nunca se modifica una cita confirmada; se cancela y se crea una nueva. |
| **Plans (maestro)** | Last-write-wins con `balance_after` | El ledger es la fuente de verdad. El `balance_after` del último ledger-entry es el saldo real. |
| **Patient records** | Merge por sección | Si dos nodos editaron distinta secciones del `anatomy_markers` JSON, se mergean los arrays. Si editaron la misma nota (`record_type="note"`), gana el de mayor `_vector_ts`. |
| **Cash movements** | Serialización por usuario | Un usuario tiene una caja abierta a la vez. Conflictos entre nodos en la misma caja = error, se marca para revisión manual. |
| **Branding / Config** | Admin wins | Solo el rol "Administrador" puede escribir en `clinics` y `roles`. Si un no-admin escribe, se rechaza en el hook. |
| **Soft deletes** | Tombstone propagation | `_deleted_at` no null gana siempre. Si un nodo borra y otro modifica, el delete gana. |

### 4.3 Pull (recibir cambios del VPS)

```
Flutter/Wails ──SSE──► VPS PocketBase
                      GET /api/sync/pull?since=<last_vector_ts>&clinic_id=<id>

VPS responde con todos los eventos de esa clínica
con vector_ts mayor al del cliente.

Cliente aplica cada evento localmente:
  - create: INSERT ignorando si ya existe (idempotente por UUID)
  - update: UPDATE solo si remote._vector_ts > local._vector_ts
  - delete: soft-delete si el registro existe localmente
```

### 4.4 Detección de Conexión

```go
// netcheck.go
func IsConnected() bool {
    ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
    defer cancel()
    req, _ := http.NewRequestWithContext(ctx, "HEAD", "https://vps.clinic.cloud/health", nil)
    resp, err := http.DefaultClient.Do(req)
    return err == nil && resp.StatusCode < 500
}

// Sync worker usa esto para decidir:
// - true:  push + pull inmediato
// - false: guarda en outbox, reintenta con backoff
```

---

## 5. Marca Blanca — Sistema de Personalización

### 5.1 Temas Dinámicos

**Desktop (Wails):**

```go
// theme.go
type ClinicTheme struct {
    PrimaryColor   string `json:"primary_color"`   // "#2563EB"
    SecondaryColor string `json:"secondary_color"` // "#7C3AED"
    FontFamily     string `json:"font_family"`     // "Inter"
    LogoURL        string `json:"logo_url"`        // path local o URL
    DarkMode       bool   `json:"dark_mode"`
}

func LoadTheme(clinicID string) (*ClinicTheme, error) {
    var clinic ClinicsRecord
    err := pb.Collection("clinics").FindRecordByID(clinicID, &clinic)
    if err != nil { return DefaultTheme(), nil }
    return parseBranding(clinic.Branding)
}
```

**CSS Variables injectadas al arranque:**

```css
/* generated dynamically from clinic.branding */
:root {
    --clinic-primary: #2563EB;
    --clinic-secondary: #7C3AED;
    --clinic-font: "Inter", system-ui, sans-serif;
    --clinic-radius: 8px;
    --clinic-logo-height: 40px;
}
```

**Flutter:**

```dart
// theme_provider.dart
class ClinicThemeProvider extends ChangeNotifier {
  ClinicTheme _theme = ClinicTheme.defaultTheme();

  Future<void> loadTheme(String clinicId) async {
    final clinic = await driftDb.clinics
        .filter((c) => c.id.equals(clinicId))
        .getSingleOrNull();
    if (clinic != null) {
      _theme = ClinicTheme.fromJson(clinic.branding);
      notifyListeners();
    }
  }

  ThemeData get themeData => ThemeData(
    colorScheme: ColorScheme.fromSeed(
      seedColor: _theme.primaryColor,
      brightness: _theme.darkMode ? Brightness.dark : Brightness.light,
    ),
    fontFamily: _theme.fontFamily,
  );
}
```

### 5.2 RBAC Dinámico

Los permisos NO están codificados como strings en el código Go. Se evaluan en runtime:

```go
// rbac.go
type Permission struct {
    Resource string  // "patients" | "appointments" | "cash" | "plans" | "settings"
    Action   string  // "create" | "read" | "update" | "delete" | "assign"
    Scope    string  // "own" | "clinic" | "all"
}

func (u *User) Can(perm Permission) bool {
    role, err := pb.Collection("roles").FindRecordByID(u.RoleID)
    if err != nil { return false }

    perms := parsePermissions(role.GetString("permissions"))
    // admin siempre puede todo
    if role.GetString("name") == "Administrador" { return true }

    for _, p := range perms {
        if p.Resource == perm.Resource && p.Action == perm.Action {
            return p.Scope == "all" ||
                   (p.Scope == "clinic" && u.ClinicID == currentClinicID) ||
                   (p.Scope == "own" && u.ID == resourceOwnerID)
        }
    }
    return false
}
```

**Ejemplo de definición de rol en la colección `roles`:**

```json
{
  "name": "Kinesiólogo",
  "permissions": [
    { "resource": "patients", "action": "read", "scope": "own" },
    { "resource": "appointments", "action": "create", "scope": "own" },
    { "resource": "appointments", "action": "update", "scope": "own" },
    { "resource": "patient_records", "action": "create", "scope": "own" },
    { "resource": "patient_records", "action": "read", "scope": "own" },
    { "resource": "cash", "action": "read", "scope": "own" },
    { "resource": "plans", "action": "read", "scope": "own" }
  ],
  "is_system": false
}
```

### 5.3 GitHub Token — Seguridad

El token de GitHub del usuario NO se guarda en PocketBase ni en la DB.

```
┌──────────────────────────────────────────────────────────┐
│  FLUJO DE PUBLICACIÓN LANDING PAGE                     │
│                                                          │
│  1. Usuario configura GitHub en Settings:               │
│     - Redirige a GitHub OAuth (scope: repo + pages)     │
│     - GitHub devuelve token con acceso limitado         │
│                                                          │
│  2. Token se guarda en:                                 │
│     Desktop:  Windows Credential Manager                │
│                (o Secret Service API en Linux)          │
│     Mobile:    Flutter SecureStorage (Keychain/Keystore)│
│                                                          │
│  3. Al publicar:                                        │
│     - Go lee token desde OS Keychain                   │
│     - go-git usa token para git push                   │
│     - Token NUNCA sale del dispositivo                 │
│     - PocketBase solo guarda el repo URL, no el token  │
└──────────────────────────────────────────────────────────┘
```

```go
// keyring.go (Wails)
import "github.com/zalando/go-keyring"

func SaveGitHubToken(userID, token string) error {
    return keyring.Set("clinic-app", "github:"+userID, token)
}

func GetGitHubToken(userID string) (string, error) {
    return keyring.Get("clinic-app", "github:"+userID)
}
```

---

## 6. Flutter como Thin Client — Estrategia de Cache

### 6.1 Modelo de Datos Local (Drift)

```dart
// mobile_database.dart
@DriftDatabase(tables: [
  Patients,
  Appointments,
  PatientRecords,
  PlanLedgers,
  Plans,
  PendingSync,
])
class AppDatabase extends _$AppDatabase {
  @override
  int get schemaVersion => 1;

  // Solo pacientes ASIGNADOS al usuario actual
  Stream<List<Patient>> watchAssignedPatients(String userId) {
    return (select(patients)
          ..where((p) => p.assignedUserIds.contains(userId)))
        .watch();
  }

  // Ultimo vector_ts conocido para pedir solo cambios增量
  Future<DateTime?> lastSyncTimestamp() async {
    final row = await (select(meta)
          ..where((m) => m.key.equals('last_sync_ts')))
        .getSingleOrNull();
    return row?.value;
  }
}
```

### 6.2 Sync Flutter ↔ PocketBase Desktop

```
┌─────────────────────────────────────────────────────────┐
│ MOBILE (Flutter + Drift)                                │
│                                                         │
│  [Biometric unlock]                                     │
│       │                                                 │
│       ▼                                                 │
│  Drift DB (cache local) ◄─────── sync_service.dart    │
│       │                         (pull + merge)          │
│       │                              ▲                  │
│       │     ┌───────────────────────┘                  │
│       │     │ (mDNS/Bonjour: buscar desktop en LAN)    │
│       │     ▼                                          │
│       │  Desktop PocketBase (localhost:8090)           │
│       │     (misma máquina o red local WiFi)            │
│       │                                                 │
│       │  Si no hay desktop disponible:                 │
│       └──────► VPS PocketBase (internet)               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Descubrimiento en LAN (mDNS):**

```dart
// network_discovery.dart
Future<String?> findLocalServer() async {
  // Buscar servicio _pocketbase._tcp.local en la red
  final results = await MDnsClient().query(
    Domain('_pocketbase._tcp.local'),
    RecordType.A,
  );
  if (results.isNotEmpty) {
    return 'http://${results.first.address}:8090';
  }
  return null; // fallback a VPS
}
```

### 6.3 Conflictos en Flutter

```dart
// sync_service.dart
Future<SyncResult> mergeRemoteChanges(List<ChangeEvent> changes) async {
  int applied = 0;
  int conflicts = 0;

  for (final change in changes) {
    final local = await db.findById(change.table, change.id);

    if (local == null) {
      // Insert directo
      await db.applyInsert(change.table, change.record);
      applied++;
      continue;
    }

    // Conflict detection
    if (change.vectorTs.isAfter(local.vectorTs)) {
      // Remote wins (LWW)
      await db.applyUpdate(change.table, change.id, change.record);
      applied++;
    } else if (change.vectorTs.isAtSameMomentAs(local.vectorTs) &&
               change.clientId != local.clientId) {
      // Mismo timestamp pero distinto cliente = conflicto
      // Regla según tabla:
      if (change.table == 'plan_ledger') {
        // NUNCA sobreescribir ledger -- generar conflicto manual
        conflicts++;
        await db.insertConflict(change);
      } else {
        await db.applyUpdate(change.table, change.id, change.record);
        applied++;
      }
    }
    // Si remote es anterior, no hacer nada (local wins)
  }

  return SyncResult(applied: applied, conflicts: conflicts);
}
```

---

## 7. Landing Page Constructor — Arquitectura

### 7.1 Modelo de Datos del Constructor

```json
// clinis.landing_config (JSON field)
{
  "pages": [
    {
      "id": "home",
      "slug": "/",
      "blocks": [
        {
          "id": "block-001",
          "type": "hero",
          "props": {
            "title": "Bienvenidos a [ClinicName]",
            "subtitle": "Cuidado profesional personalizado",
            "cta_text": "Reservar turno",
            "cta_url": "/appointments"
          }
        },
        {
          "id": "block-002",
          "type": "services_grid",
          "props": {
            "columns": 3,
            "services": [
              { "name": "Fisioterapia", "icon": "healing", "description": "..." }
            ]
          }
        },
        {
          "id": "block-003",
          "type": "team_carousel",
          "props": {
            "users_filter": { "role": "Médico" }
          }
        },
        {
          "id": "block-004",
          "type": "testimonials",
          "props": {
            "source": "approved_appointments",
            "limit": 6
          }
        },
        {
          "id": "block-005",
          "type": "contact_form",
          "props": {
            "fields": ["name", "phone", "reason"],
            "notify_admins": true
          }
        }
      ]
    }
  ],
  "settings": {
    "favicon_url": "...",
    "meta_title": "Clínica XYZ | Fisioterapia",
    "meta_description": "...",
    "custom_css": "..."
  }
}
```

### 7.2 Pipeline de Generación y Deploy

```
┌─────────────────────────────────────────────────────────────┐
│  LANDING BUILD PIPELINE (en Go, corriendo en Wails)       │
│                                                             │
│  1. Leer landing_config desde PocketBase local            │
│  2. Resolve dynamic data:                                │
│     - [ClinicName] → clinics.name                        │
│     - team_carousel → query users.filtered(role)         │
│     - testimonials → approved_appointments con reviews   │
│  3. Para cada bloque, renderizar template HTML parcial    │
│  4. Ensamblar page.html completo con header/footer       │
│  5. Inject CSS variables desde clinics.branding          │
│  6. Git commit + push via go-git                         │
│     (token desde OS Keychain, repo desde settings)        │
│  7. GitHub Actions / Pages sirve el sitio                │
└─────────────────────────────────────────────────────────────┘
```

### 7.3 Bloques Disponibles

| Bloque | Props clave | Datos dinámicos |
|---|---|---|
| `hero` | title, subtitle, cta | ClinicName, ClinicLogo |
| `services_grid` | columns, services[] | - |
| `team_carousel` | users_filter | Lista de usuarios con rol |
| `testimonials` | source, limit | Turnos completados con rating |
| `contact_form` | fields[], notify | submissions van a DB |
| `appointment_cta` | - | Link a booking externo |
| `opening_hours` | schedule | Horarios desde settings |
| `gallery` | images[] | Imágenes de la clínica |
| `faq_accordion` | items[] | - |
| `custom_html` | code | HTML libre (sanitizado) |

---

## 8. Notificaciones — Cola y Canales

```
┌─────────────────────────────────────────────────────────────┐
│  Cola de Notificaciones                                    │
│                                                             │
│  Notification triggered                                    │
│       │                                                    │
│       ▼                                                    │
│  INSERT into notifications (status=pending)               │
│       │                                                    │
│       ├──────────────────┬──────────────────┐              │
│       ▼                  ▼                  ▼              │
│  [Email Worker]    [WhatsApp Worker]  [Push Worker]       │
│  (SMTP / Resend)  (Twilio /Meta)    (FCM)               │
│       │                  │                  │              │
│       └──────────────────┴──────────────────┘              │
│                          │                                 │
│                    UPDATE status                           │
│                    sent_at / error                         │
└─────────────────────────────────────────────────────────────┘

Triggers configurables:
  - appointment.reminder: 24h / 2h antes
  - appointment.confirmation: al confirmar
  - appointment.reminder_sessions: cuando plan.sessions_remaining <= 2
  - patient.birthday: el dia
  - cash.closing_summary: daily report al admin
```

---

## 9. Estructura de Proyecto

```
clinic-system/
├── cmd/
│   ├── desktop/          # Wails main.go
│   ├── mobile/           # Flutter entry point
│   └── sync-worker/      # Worker standalone (para VPS)
│
├── internal/
│   ├── core/             # Lógica de negocio pura (sin dependencias de transporte)
│   │   ├── appointments/
│   │   ├── patients/
│   │   ├── plans/
│   │   ├── ledger/
│   │   ├── cash/
│   │   ├── records/
│   │   └── notifications/
│   │
│   ├── sync/            # Motor de sincronización
│   │   ├── outbox.go
│   │   ├── worker.go
│   │   ├── conflict.go
│   │   └── netcheck.go
│   │
│   ├── auth/            # Auth y RBAC
│   │   ├── biometric.go
│   │   ├── jwt.go
│   │   └── rbac.go
│   │
│   ├── branding/        # Sistema de temas y marca blanca
│   │   ├── theme.go
│   │   └── css_inject.go
│   │
│   ├── landing/         # Constructor de landing
│   │   ├── compiler.go
│   │   ├── templates/
│   │   │   ├── hero.html
│   │   │   ├── services_grid.html
│   │   │   └── ...
│   │   └── deploy.go
│   │
│   ├── keyring/         # Abstacción OS credential store
│   │   ├── keyring.go
│   │   └── mock.go      # para tests
│   │
│   └── pocketbase/      # PocketBase SDK wrapper
│       ├── client.go
│       └── hooks.go
│
├── pkg/
│   └── pb/              # PocketBase generated Go SDK
│
├── mobile/              # Flutter app
│   ├── lib/
│   │   ├── database/    # Drift schema
│   │   ├── sync/        # Sync service
│   │   ├── theme/       # Theme provider
│   │   └── ui/          # Screens
│   └── pubspec.yaml
│
├── web/                # Wails frontend (React/Vue/Svelte)
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   └── stores/
│   └── wailsjs/
│
├── migrations/         # PocketBase migrations (SQL)
│   ├── 001_initial_schema.sql
│   └── ...
│
└── tests/
    ├── sync_test.go
    ├── rbac_test.go
    ├── conflict_resolution_test.go
    └── e2e/
```

---

## 10. Decisiones Clave — Resumen

| Pregunta | Decisión | Justificación |
|---|---|---|
| ¿Sync es real-time o bajo demanda? | Background worker con SSE para pull, REST para push | PocketBase ya tiene SSE. No reinventar WebSocket. |
| ¿Flutter tiene DB completa o cache? | Cache subset (pacientes asignados) | DB completa en mobile es riesgo de seguridad médica. |
| ¿Cómo se resuelven conflictos de citas? | Append-only ledger, cita referencia ledger-entry | Elimina race condition de "sesiones restantes". |
| ¿Dónde se guarda el token GitHub? | OS Keychain, no PocketBase | Si PB se compromete, el token sigue seguro. |
| ¿RBAC es hard-coded o dinámico? | Roles como data en colección `roles` | Permite agregar "Kinesiólogo" sin deploy. |
| ¿Cómo funciona offline en mobile? | Drift cache + mDNS para sync con desktop local | Sin internet no se sync, pero la app funciona. |
| ¿Landing es un microservicio? | Go compiler embebido en Wails | Sin servidor extra. El usuario compila y pushea. |
| ¿Pueden dos usuarios editar la misma nota clínica? | Merge por sección o LWW por timestamp | Los marcadores anatómicos son arrays (merge). Las notas son texto (LWW). |

---

*Documento generado como parte del diseño de arquitectura del sistema de gestión clínica local-first. Revisar y ajustar según regulaciones locales de datos médicos.*
