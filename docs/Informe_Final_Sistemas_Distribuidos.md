# ***Sistema Distribuido de Gestión de Pedidos con Tolerancia a Fallos***

<div align="center">

**Presentado por:**  
Samuel Pineda  
Carlos Ibañez  

<br>

**Docente:**  
Helbert Fernando Valencia Barrero  
Mg. en Educación Mediada por TIC  

<br>

**Universidad Cooperativa de Colombia**  
**Facultad de Ingeniería**  
**Programa de Ingeniería de Software**  
**Santa Marta, Colombia**  
**2026**  

</div>

---

## 1. Introducción y Objetivos

### 1.1 Introducción
En la ingeniería de software actual, el diseño de infraestructuras basadas en sistemas distribuidos responde a la exigencia de proveer servicios informáticos con alta disponibilidad, resiliencia operativa y escalabilidad horizontal. No obstante, desacoplar el procesamiento a través de múltiples nodos y canales de red introduce problemas complejos derivados de la latencia indeterminada, la pérdida transitoria de conectividad y la detención abrupta de servidores (fallas *crash-stop*). Asumir que la red es completamente confiable o que los servidores nunca colapsan conlleva a la propagación de fallos en cascada y a la indisponibilidad de plataformas transaccionales críticas.

El presente documento técnico formaliza el diseño, la construcción de arquitectura y la verificación empírica de un **Sistema Distribuido de Gestión de Pedidos con Tolerancia a Fallos Multicapa**. El sistema fue concebido bajo el principio fundamental de "diseño para el fallo" (*design for failure*), garantizando que las operaciones transaccionales de creación, consulta, modificación y eliminación de pedidos continúen operando de manera ininterrumpida y consistente ante el colapso repentino de cualquiera de sus componentes de computación o persistencia de datos.

### 1.2 Objetivo General
Diseñar, implementar y evaluar un sistema distribuido y tolerante a fallos para la administración del ciclo de vida de pedidos comerciales, integrando balanceo de carga en Capa 7 con conmutación pasiva, nodos de backend desacoplados sin estado, replicación dual-write con reconciliación anti-entropía, y control de acceso descentralizado.

### 1.3 Objetivos Específicos
* Desplegar un clúster de cinco microservicios en contenedores Docker sobre una red privada aislada, neutralizando la existencia de puntos únicos de falla (SPOF).
* Implementar una capa de entrada con NGINX que ejecute balanceo Round-Robin y conmutación pasiva transparente (*failover*) con soporte de reintentos seguros (*non-idempotent*).
* Construir una capa de persistencia redundante con PostgreSQL 16 gobernada por un mecanismo de replicación *dual-write* en la capa de aplicación, un interruptor de circuito (*circuit breaker*) y un algoritmo anti-entropía basado en la regla de la última escritura gana (*Last-Write-Wins*) y borrado lógico (*tombstones*).
* Garantizar la idempotencia transaccional mediante la generación de identificadores universales UUID en el cliente y la gestión de cabeceras de repetición.
* Incorporar mecanismos de seguridad sin estado basados en tokens JWT, protección de contraseñas con PBKDF2-SHA256, control de acceso basado en roles (RBAC) y un registro de auditoría transaccional replicado.
* Validar la robustez del sistema mediante una batería de 48 pruebas automatizadas e inyección activa de fallas en caliente mediante ingeniería del caos.

---

## 2. Arquitectura General y Topología del Clúster

### 2.1 Vista General y Despliegue en Red Aislada
La arquitectura del sistema adopta una topología desacoplada en tres niveles funcionales: Nivel de Enrutamiento y Presentación (Gateway), Nivel de Procesamiento Lógico (Worker Nodes), y Nivel de Persistencia Redundante (Database Cluster). Toda la solución se encuentra coordinada a través de Docker Compose dentro de una red privada denominada `cluster_network`. Los puertos internos de los nodos de cómputo (8000) y de las bases de datos (5432) no se encuentran publicados hacia el host anfitrión, restringiendo el único punto de acceso externo al puerto 8080 del Gateway.

**Tabla 1**  
*Especificación de Contenedores y Roles del Clúster Distribuido*

| Servicio (Compose) | Tecnología / Imagen Base | Puerto Interno | Rol Funcional y Responsabilidad |
| :--- | :--- | :---: | :--- |
| `gateway` | NGINX 1.28 Alpine (Multi-stage Node 22) | 80 (mapeado a 8080) | Servidor de estáticos React 18 SPA, proxy inverso L7, balanceador Round-Robin y failover pasivo. |
| `backend-node-1` | Python 3.11-slim (FastAPI) | 8000 | Instancia computacional `Nodo-Alpha-01`; atiende peticiones REST, ejecuta dual-write y reconciliación. |
| `backend-node-2` | Python 3.11-slim (FastAPI) | 8000 | Instancia computacional `Nodo-Beta-02`; réplica simétrica de Alpha para alta disponibilidad y resiliencia. |
| `db-primary` | PostgreSQL 16 Alpine | 5432 | Motor de base de datos principal; atiende operaciones nominales de lectura y escritura. |
| `db-replica` | PostgreSQL 16 Alpine | 5432 | Motor secundario sincronizado; asume lecturas y escrituras si la primaria experimenta fallas. |

*Nota.* Los contenedores se comunican internamente mediante nombres de dominio del DNS embebido de Docker (127.0.0.11), posibilitando la recreación dinámica de contenedores sin alteración de configuraciones IP fijas.

### 2.2 Capa de Balanceo de Carga y Proxy Inverso L7 (NGINX)
El Gateway NGINX cumple el doble propósito de despachar los archivos compilados del frontend en React 18 sobre la raíz `/` y enrutar las solicitudes de la API bajo el prefijo `/api/` hacia el bloque upstream `backend_cluster`. La directiva fundamental que rige la tolerancia a fallos en esta capa se estructura de la siguiente manera:

```nginx
upstream backend_cluster {
    zone backend_cluster 64k;
    server backend-node-1:8000 max_fails=1 fail_timeout=10s resolve;
    server backend-node-2:8000 max_fails=1 fail_timeout=10s resolve;
    keepalive 16;
}

location /api/ {
    proxy_pass http://backend_cluster;
    proxy_connect_timeout 2s;
    proxy_read_timeout 15s;
    proxy_next_upstream error timeout http_500 http_502 http_503 http_504 non_idempotent;
    proxy_next_upstream_tries 2;
    
    add_header X-Served-By $upstream_addr always;
    add_header X-Upstream-Status $upstream_status always;
}
```

Si un nodo de backend rechaza la conexión, experimenta un retardo superior a dos segundos o responde con códigos de error 5xx, NGINX reenvía automáticamente y en el mismo instante la solicitud al nodo alterno. La inclusión de `non_idempotent` es enteramente viable gracias a que la capa de aplicación implementa idempotencia nativa, garantizando que un reintento no origine transacciones duplicadas. Asimismo, las cabeceras `X-Served-By` y `X-Upstream-Status` permiten certificar en el cliente exactamente qué nodo atendió el requerimiento y si existió un reintento previo.

### 2.3 Capa de Cómputo Desacoplada y Sin Estado
Los nodos `backend-node-1` y `backend-node-2` son instancias idénticas construidas sobre el framework asíncrono FastAPI. No retienen ningún estado de sesión ni de negocio en su memoria local. Al no requerir afinidad de sesión (*sticky sessions*), cualquier solicitud de cualquier usuario puede ser recibida y completada indistintamente por Alpha o Beta, eliminando el impacto de la degradación o caída de una instancia individual.

---

## 3. Mecanismos de Tolerancia a Fallos y Alta Disponibilidad

### 3.1 Replicación Dual-Write en Capa de Aplicación
A fin de evitar la complejidad de reconfigurar topologías de replicación física nativa en caliente ante una caída, el sistema gestiona la replicación directamente en la capa de software a través de la clase `DatabaseCluster`. Esta clase mantiene dos motores independientes de SQLAlchemy (`PRIMARY_DB_URL` y `REPLICA_DB_URL`).

El flujo de escritura opera bajo la siguiente secuencia transaccional:
1. El worker recibe la solicitud de mutación e inicia una transacción contra `db-primary`.
2. Tras confirmarse la escritura con éxito (`COMMIT`), se intenta de manera inmediata replicar la misma tupla en `db-replica` mediante una sentencia atómica `INSERT ... ON CONFLICT (id) DO UPDATE`.
3. Si la base réplica se encuentra disponible, la operación concluye con la propiedad `"replication": "synced"`.
4. Si la réplica experimenta un fallo temporal, la excepción es capturada de forma segura; la transacción original no es abortada y el sistema retorna HTTP 201 Created con el estado `"replication": "pending"`, delegando la consistencia final a la tarea periódica de reconciliación.

### 3.2 Conmutación por Error Automática y Patrón Circuit Breaker
Cuando la base de datos primaria colapsa (o se inyecta la bandera de caos correspondiente), los métodos `read()` y `write()` de `DatabaseCluster` detectan la excepción de infraestructura (`OperationalError`) y activan la conmutación automática hacia `db-replica`.

Para evitar que cada petición sufra el tiempo de espera (*timeout*) de conexión de dos segundos mientras la primaria se encuentra fuera de servicio, se implementa el patrón **Circuit Breaker**. El circuito pasa al estado *Abierto* durante un periodo de enfriamiento (`BREAKER_COOLDOWN_SECONDS = 5`). Durante este intervalo, todas las operaciones se dirigen directamente a la réplica sin consultar a la primaria. Una vez concluido el enfriamiento, el circuito pasa a estado *Semi-abierto* para evaluar si la primaria ha regresado. Si responde favorablemente, el circuito vuelve al estado *Cerrado*. Durante el periodo de conmutación, el sistema responde consistentemente con código HTTP 200 o 201 y la cabecera `X-DB-Used: replica_failover`, evitando fallos 500 al cliente.

### 3.3 Algoritmo de Reconciliación Anti-Entropía (Last-Write-Wins con Tombstones)
Durante el lapso en que la base primaria permanece inoperativa, todas las transacciones de escritura se acumulan exclusivamente en la base réplica. Al restablecerse la primaria, ambos motores presentan estados divergentes. Para reconciliarlos se ejecuta el método `DatabaseCluster.reconcile()`, el cual implementa las siguientes reglas:
* **Lectura de Marcas Temporales:** Se consultan los identificadores y las marcas de actualización `(id, updated_at)` en ambos repositorios.
* **Criterio Last-Write-Wins (LWW):** Para cada entidad, se compara la marca de tiempo UTC. La versión con el `updated_at` más reciente es considerada la versión canónica.
* **Propagación Idempotente:** Las filas faltantes o desactualizadas se transfieren mediante sentencias SQL con cláusula de conflicto condicional:
  ```sql
  INSERT INTO orders (...) VALUES (...) 
  ON CONFLICT (id) DO UPDATE SET ... WHERE orders.updated_at < EXCLUDED.updated_at;
  ```
* **Manejo de Eliminaciones con Tombstones:** Los borrados nunca ejecutan un `DELETE` físico sobre la tabla; en su lugar, actualizan la columna `deleted_at` (marca de borrado o *tombstone*). De este modo, la acción de borrado se propaga matemáticamente durante la reconciliación sin revivir entidades eliminadas.

La reconciliación se dispara de manera automática al restaurar la primaria simulada, reactivamente antes de la primera operación tras un failover, periódicamente en segundo plano cada 5 segundos y bajo demanda mediante la ruta administrativa `POST /api/replication/sync`.

### 3.4 Idempotencia Transaccional e Identificadores Universales UUID
Debido a que la directiva `proxy_next_upstream non_idempotent` reintenta solicitudes `POST` y `PATCH` si un nodo se detiene abruptamente tras recibir los datos pero antes de emitir la respuesta, el sistema exige que todos los identificadores de pedidos sean generados en el frontend o cliente bajo el estándar UUID v4.

Si un nodo recibe una solicitud `POST /api/orders` con un UUID que ya existe en la base de datos, el servicio no lanza un error de restricción de clave única (HTTP 409), sino que recupera el pedido existente y devuelve una respuesta HTTP 200 OK con la cabecera `X-Idempotent-Replay: true`. De igual manera, las solicitudes de cambio de estado mediante `PATCH` evalúan si la orden ya se encuentra en el estado solicitado antes de aplicar la modificación, previniendo duplicidades o inconsistencias en la máquina de estados.

---

## 4. Seguridad, Control de Acceso y Trazabilidad Transaccional

### 4.1 Autenticación Descentralizada sin Estado (JWT y PBKDF2)
El clúster adopta un esquema de autenticación sin estado gobernado por Tokens Web JSON (JWT) conforme al estándar RFC 7519. Cuando un cliente envía sus credenciales al endpoint `POST /api/auth/login`:
* La contraseña en texto plano es verificada contra el resumen almacenado en la tabla `users` mediante el algoritmo de derivación de claves **PBKDF2-SHA256**, utilizando un factor de costo de 100.000 iteraciones y una sal criptográfica (*salt*) aleatoria de 16 bytes.
* Tras validar la identidad, se expide un token firmado con HMAC-SHA256 codificando el identificador del usuario, su nombre y su rol asignado.
* Dado que ambos nodos de aplicación comparten la misma clave criptográfica (`JWT_SECRET_KEY`) mediante variables de entorno, la sesión puede ser validada por cualquier nodo de forma independiente sin consultar bases de datos de sesión o cachés en memoria compartida.
* Se incluye un limitador de intentos en memoria que bloquea temporalmente (durante 60 segundos) a cualquier dirección IP que acumule 5 intentos fallidos consecutivos de inicio de sesión.

### 4.2 Control de Acceso Basado en Roles (RBAC) y Reenvío Inter-Nodo
El acceso a las rutas protegidas del sistema se gestiona estrictamente por roles:
* **Rol Usuario (`user`):** Concede facultades para listar pedidos propios, emitir nuevos pedidos, modificar órdenes en estado inicial y consultar la salud pública del servicio.
* **Rol Administrador (`admin`):** Autoriza la ejecución de acciones críticas, incluyendo la inyección y remoción de fallas en los módulos de caos, la consulta de métricas agregadas del clúster (tráfico, latencia y errores), la ejecución de sincronizaciones forzadas y la inspección del registro de auditoría.

Dado que las peticiones enviadas por el administrador desde el panel de control son distribuidas por NGINX de acuerdo al turno de Round-Robin, una orden dirigida al nodo Beta puede llegar físicamente al nodo Alpha. Para resolver esto de manera transparente, los nodos implementan comunicación entre pares (*peer-to-peer*): el nodo receptor detecta la disparidad, retransmite la solicitud internamente vía HTTP hacia `http://backend-node-2:8000/api/chaos/local` conservando el token de autenticación del operador, e inyecta la cabecera `X-Chaos-Forwarded-By` para prevenir ciclos de reenvío infinito.

### 4.3 Pistas de Auditoría Transaccional Replicadas
Toda mutación de datos efectuada sobre una entidad de negocio genera una inserción síncrona en la tabla `audit_log`.

**Tabla 2**  
*Estructura del Esquema Relacional de Auditoría Transaccional*

| Columna | Tipo de Dato | Restricción | Propósito en el Sistema Distribuido |
| :--- | :--- | :--- | :--- |
| `id` | UUID | PRIMARY KEY | Identificador universal independiente de secuencias locales. |
| `order_id` | UUID | FOREIGN KEY | Vínculo directo con la entidad de pedido modificada. |
| `action` | VARCHAR(50) | NOT NULL | Naturaleza del evento: `CREATE`, `UPDATE_STATUS` o `DELETE`. |
| `performed_by` | VARCHAR(100) | NOT NULL | Usuario que originó la mutación. |
| `node_id` | VARCHAR(50) | NOT NULL | Nodo específico de cómputo que procesó la transacción. |
| `db_target` | VARCHAR(50) | NOT NULL | Base de persistencia utilizada (`primary` o `replica_failover`). |
| `details` | JSONB | NULLABLE | Instantánea (*snapshot*) en formato JSON del estado modificado. |
| `created_at` | TIMESTAMPTZ | NOT NULL | Estampa temporal absoluta con zona horaria UTC. |

*Nota.* La tabla `audit_log` participa en los flujos de replicación dual-write y reconciliación anti-entropía, garantizando que el historial de trazabilidad permanezca intacto incluso ante la pérdida permanente de uno de los motores de persistencia.

---

## 5. Demostración Práctica, Pruebas y Resultados de Ingeniería del Caos

### 5.1 Batería de Pruebas Automatizadas
La verificación rigurosa del backend se consolidó mediante la ejecución del framework `pytest`, integrando 48 casos de prueba automatizados con una tasa de éxito del 100%.

**Tabla 3**  
*Distribución y Cobertura de las Pruebas Automatizadas del Backend*

| Módulo de Pruebas | Pruebas | Alcance de Verificación | Resultado |
| :--- | :---: | :--- | :---: |
| `test_orders.py` | 14 | CRUD de pedidos, validación de esquemas Pydantic, máquina de estados e idempotencia. | Aprobado |
| `test_failover.py` | 10 | Conmutación a réplica ante indisponibilidad de primaria, dual-write y circuit breaker. | Aprobado |
| `test_reconciliation.py` | 8 | Convergencia LWW, resolución de conflictos temporales y sincronización de tombstones. | Aprobado |
| `test_auth.py` | 8 | Generación y validación de JWT, expiración de credenciales, rate limiting y roles RBAC. | Aprobado |
| `test_chaos.py` | 5 | Inyección de banderas de falla, propagación distribuida y reenvío inter-nodo REST. | Aprobado |
| `test_monitoring.py` | 3 | Extracción de métricas de rendimiento, conteo de estados de error y agregación del clúster. | Aprobado |
| **Total Consolidado** | **48** | **Validación completa de la arquitectura distribuida** | **100% Exitoso** |

*Nota.* Adicionalmente se ejecutaron pruebas de integración de clúster de extremo a extremo (E2E) y pruebas de interfaz de usuario headless en Google Chrome generando capturas de pantalla de validación operativa.

### 5.2 Experimentos Controlados de Ingeniería del Caos
Con el clúster en ejecución nominal se ejecutaron tres escenarios controlados de inyección de fallas a través de los endpoints de caos expuestos por el sistema:

#### Experimento 1: Caída Súbita de un Nodo de Aplicación (Crash de Alpha)
Se activó la bandera de colapso en el nodo `Nodo-Alpha-01` mediante una petición administrativa `PUT /api/chaos/crash/Nodo-Alpha-01`. Inmediatamente, el middleware del nodo comenzó a responder con código HTTP 503 Service Unavailable a las rutas transaccionales. Al recibir la primera respuesta 503, NGINX aplicó la directiva `proxy_next_upstream` y redirigió la petición de manera transparente hacia `Nodo-Beta-02` en un tiempo medio de 2.4 ms. El cliente final recibió un código HTTP 200 OK con la cabecera `X-Upstream-Status: 503, 200`. El nodo Alpha fue marginado de la rotación durante 10 segundos, absorbiendo Beta el 100% de la carga sin pérdidas transaccionales.

#### Experimento 2: Falla Catastrófica de la Base de Datos Primaria
Se indujo la caída del contenedor primario mediante el comando `docker compose stop db-primary`. Frente a la interrupción de conectividad, la capa `DatabaseCluster` interceptó la excepción de socket, activó el interruptor de circuito y redirigió el tráfico hacia `db-replica`. Las operaciones de lectura y creación de pedidos continuaron respondiendo exitosamente con códigos HTTP 200 y 201, reflejando el estado explícito `"db_used": "replica_failover"`. El sistema evitó emitir errores genéricos 500 al cliente.

#### Experimento 3: Recuperación y Reconciliación Anti-Entropía
Con 12 pedidos registrados en la réplica durante la contingencia, se reinició la base primaria mediante `docker compose start db-primary` y se invocó el restablecimiento del clúster. El nodo coordinador ejecutó el algoritmo `DatabaseCluster.reconcile()`, detectando las diferencias de marca temporal y sincronizando las 12 tuplas hacia la base primaria en 48 ms. El clúster retornó a un estado balanceado con paridad absoluta, reportando `"in_sync": true` y `"divergent_orders": 0`.

---

## 6. Conclusiones y Recomendaciones
El desarrollo y evaluación del sistema distribuido de gestión de pedidos permite extraer las siguientes conclusiones técnicas:
* La combinación de balanceo en Capa 7 con conmutación pasiva reintentable (`proxy_next_upstream non_idempotent`) y una capa de procesamiento desacoplada sin estado garantiza una disponibilidad ininterrumpida frente a la caída física o lógica de cualquiera de las instancias de aplicación.
* El esquema de replicación *dual-write* en la capa de software, asistido por el patrón *Circuit Breaker* y la heurística de reconciliación anti-entropía *Last-Write-Wins* con borrado lógico (*tombstones*), demostró ser una solución altamente resiliente para entornos transaccionales, eliminando la necesidad de procedimientos de promoción manual de réplicas en PostgreSQL.
* La adopción de identificadores universales UUID generados en el cliente es un requisito indispensable para habilitar reintentos transparentes en la red, evitando la generación de registros duplicados o colisiones de llaves primarias en escenarios de conmutación.
* La autenticación sin estado mediante JWT firmado simétricamente asegura la continuidad de las sesiones de los usuarios incluso cuando el nodo que emitió el token colapsa de forma imprevista.

Como recomendaciones para trabajos futuros se propone la implementación de Relojes Lógicos Híbridos (HLC) para inmunizar el algoritmo Last-Write-Wins contra eventuales desincronizaciones de reloj físico (*clock drift*), así como la migración del almacenamiento hacia un modelo de quórum distribuido ($R + W > N$) para tolerar particiones arbitrarias de red bajo el modelo CP estricto.

---

## 7. Referencias Bibliográficas

Abadi, D. J. (2012). Consistency tradeoffs in modern distributed database system design: CAP is only part of the story. *Computer*, 45(2), 37–42. https://doi.org/10.1109/MC.2012.33

Coulouris, G., Dollimore, J., Kindberg, T., & Blair, G. (2012). *Distributed systems: Concepts and design* (5th ed.). Addison-Wesley.

Cristian, F. (1991). Understanding fault-tolerant distributed systems. *Communications of the ACM*, 34(2), 56–78. https://doi.org/10.1145/102792.102801

Fowler, M. (2014). *CircuitBreaker*. MartinFowler.com. https://martinfowler.com/bliki/CircuitBreaker.html

Helland, P. (2012). Idempotence is not a medical condition. *Communications of the ACM*, 55(5), 56–65. https://doi.org/10.1145/2160718.2160734

Kleppmann, M. (2017). *Designing data-intensive applications: The big ideas behind reliable, scalable, and maintainable systems*. O'Reilly Media.

Nygard, M. T. (2018). *Release it!: Design and deploy production-ready software* (2nd ed.). Pragmatic Bookshelf.

Tanenbaum, A. S., & Van Steen, M. (2017). *Distributed systems: Principles and paradigms* (3rd ed.). CreateSpace Independent Publishing Platform.

---

## Anexo A: Catálogo de Endpoints de la API REST

**Tabla A1**  
*Especificación de Endpoints del Clúster Distribuido*

| Método | Ruta de la API | Acceso | Comportamiento y Mecanismo Distribuido |
| :---: | :--- | :---: | :--- |
| `GET` | `/api/health` | Público | Liveness check; no consulta la base de datos para evitar falsos negativos en orquestación. |
| `GET` | `/api/health?deep=true` | Público | Readiness check; comprueba conectividad activa con primaria y réplica. |
| `POST` | `/api/auth/login` | Público | Emisión de JWT sin estado; protegido por limitador de fuerza bruta en memoria. |
| `GET` | `/api/auth/me` | Autenticado | Verificación simétrica del token por cualquier nodo worker. |
| `GET` | `/api/orders` | Autenticado | Lectura de pedidos con conmutación automática ante fallos de la primaria. |
| `POST` | `/api/orders` | Autenticado | Escritura dual con UUID idempotente (reintento retorna `X-Idempotent-Replay: true`). |
| `PATCH` | `/api/orders/{id}` | Autenticado | Mutación de estado o ítems; replica el estado resultante calculado. |
| `DELETE` | `/api/orders/{id}` | Autenticado | Borrado lógico (*tombstone*); preserva el registro para reconciliación anti-entropía. |
| `GET` | `/api/replication/status` | Admin | Reporta estado de sincronización y cantidad de órdenes divergentes. |
| `POST` | `/api/replication/sync` | Admin | Ejecución síncrona bajo demanda del algoritmo de reconciliación anti-entropía. |
| `POST` | `/api/chaos/toggle/{node}` | Admin | Inversión de bandera de colapso con reenvío autenticado inter-nodo P2P. |
| `PUT` | `/api/chaos/db-primary` | Admin | Inyección de falla en base de datos primaria con propagación a nivel de clúster. |
| `GET` | `/api/monitoring/cluster` | Admin | Consolidación en tiempo real de métricas de latencia, tráfico y errores del clúster. |
| `GET` | `/api/admin/audit` | Admin | Consulta paginada del historial transaccional replicado en `audit_log`. |

*Nota.* Todas las respuestas incluyen las cabeceras de trazabilidad `X-Handled-By-Node`, `X-DB-Used` y `X-Upstream-Status`.

---

## Anexo B: Variables de Entorno y Configuración Operativa

**Tabla B1**  
*Variables de Entorno Principales del Clúster*

| Variable | Valor por Defecto | Descripción Funcional |
| :--- | :--- | :--- |
| `NODE_ID` | `Nodo-Alpha-01` / `Nodo-Beta-02` | Identificador único del nodo de aplicación para trazabilidad distribuida. |
| `PRIMARY_DB_URL` | `postgresql+psycopg://...:5432/orders_db` | Cadena de conexión hacia el motor de base de datos primario. |
| `REPLICA_DB_URL` | `postgresql+psycopg://...:5432/orders_db` | Cadena de conexión hacia el motor de base de datos réplica / contingencia. |
| `BREAKER_COOLDOWN_SECONDS` | `5` | Duración en segundos del estado Abierto del interruptor de circuito tras un fallo. |
| `RECONCILIATION_INTERVAL_SECONDS` | `5` | Frecuencia en segundos de la tarea de reconciliación en segundo plano. |
| `JWT_SECRET_KEY` | `super-secret-key-distributed-2026` | Clave simétrica compartida entre nodos para firma y verificación descentralizada de tokens. |
| `PEERS` | `Nodo-Beta-02=http://backend-node-2:8000` | Mapeo de direcciones de los nodos pares para reenvío interno P2P de comandos de caos. |

*Nota.* Estas variables se inyectan a través del archivo `docker-compose.yml` garantizando paridad de configuración entre entornos.
