# NREG WhatsApp Matcher

MVP de captura manual y matching entre ofertas y demandas inmobiliarias para New Real Estate Group.

## Qué incluye

- Webhook de WhatsApp Business API.
- Validación opcional de firma de Meta.
- Allowlist de números administradores.
- Clasificación de mensajes como oferta, demanda o irrelevante.
- Extracción con IA opcional o parser determinista local.
- Confirmación obligatoria antes de guardar.
- Persistencia SQLite local o Supabase PostgreSQL en Vercel.
- Expiración automática a los 15 días.
- Matching bidireccional con score de 80/100.
- Alertas por el mismo chat de WhatsApp.
- Panel web básico para revisar, cerrar y renovar registros.

## Arranque local

Requiere Node.js 24 o superior.

```bash
cp .env.example .env
npm test
npm start
```

Abrir `http://localhost:3000` para el panel.

Sin credenciales de WhatsApp, el servidor usa dry-run y muestra las respuestas en la terminal. Sin `OPENAI_API_KEY` y `OPENAI_MODEL`, usa el parser determinista incluido.

Si defines `SUPABASE_URL` y `SUPABASE_SECRET_KEY`, el servidor usa Supabase en lugar de SQLite. La `SUPABASE_SECRET_KEY` sólo debe existir en variables de entorno del servidor; nunca debe exponerse en `public/` ni en el navegador.

## Despliegue con GitHub, Vercel y Supabase

1. Crea un proyecto de Supabase y ejecuta `supabase/migrations/20260922000000_nreg_matcher.sql` en el SQL Editor.
2. Copia la URL del proyecto y la Secret Key desde el panel de Supabase.
3. Sube este repositorio a GitHub.
4. Importa el repositorio en Vercel.
5. En Vercel agrega las variables de `.env.example`, incluyendo `SUPABASE_URL` y `SUPABASE_SECRET_KEY`.
6. Despliega. Vercel usará `api/index.js` como función y conservará el panel estático de `public/`.
7. Usa `https://tu-proyecto.vercel.app/webhooks/whatsapp` como callback URL de Meta.

El almacenamiento Supabase usa RLS habilitado y bloquea los roles públicos. Las consultas del webhook se realizan server-side con la Secret Key.

## Configuración de WhatsApp

Configurar en `.env`:

```text
WHATSAPP_VERIFY_TOKEN=un-token-secreto
WHATSAPP_ACCESS_TOKEN=token-de-meta
WHATSAPP_PHONE_NUMBER_ID=id-del-numero
WHATSAPP_APP_SECRET=app-secret-opcional
WHATSAPP_MATCH_TEMPLATE_NAME=nreg_match_alert
WHATSAPP_MATCH_TEMPLATE_LANGUAGE=es_MX
ADMIN_PHONE_NUMBERS=5215555555555
```

Registrar como webhook:

```text
GET/POST https://tu-dominio.com/webhooks/whatsapp
```

El `GET` valida el webhook con `WHATSAPP_VERIFY_TOKEN`; el `POST` recibe mensajes entrantes. En producción se debe configurar HTTPS y `WHATSAPP_APP_SECRET` para verificar `x-hub-signature-256`.

Para alertas de matches que puedan ocurrir más de 24 horas después del último mensaje, crea y aprueba en WhatsApp Manager una plantilla llamada `nreg_match_alert` con cuatro variables de cuerpo: score, ID de oferta, ID de demanda y razones. Si no configuras la plantilla, el MVP envía texto libre, adecuado para pruebas y respuestas dentro de la ventana iniciada por el usuario.

## Configuración de extracción con IA

Si se desea utilizar extracción estructurada con un proveedor compatible con Chat Completions:

```text
OPENAI_API_KEY=...
OPENAI_MODEL=...
```

Si la llamada falla, el agente vuelve automáticamente al parser determinista y deja registro del error.

## Flujo del usuario

1. Reenviar un mensaje de grupo al número NREG.
2. Recibir una ficha normalizada.
3. Responder `CONFIRMAR`, `CORREGIR` o `CANCELAR`.
4. El registro queda activo 15 días.
5. Si aparece un match fuerte, llega una alerta al mismo chat.

Comandos adicionales: `AYUDA`, `CERRAR <id>` y `RENOVAR <id>`.

## Próximos pasos de producción

- Sustituir SQLite por PostgreSQL gestionado.
- Añadir autenticación fuerte al panel.
- Configurar secretos en un secret manager.
- Añadir reintentos y cola administrada para envíos de WhatsApp.
- Añadir OCR y audio sólo después de validar el flujo de texto.
- Revisar aviso de privacidad, retención y autorización de los datos reenviados.
