import { z } from 'zod';

/**
 * Request body validation middleware.
 * Parses req.body against the provided Zod schema.
 * On failure: 400 { error: '<messages>' }
 * On success: replaces req.body with coerced/defaulted values and calls next().
 *
 * Usage:
 *   import { validate } from '../middleware/validate.js';
 *   router.post('/', authenticate, validate(CreatePostSchema), async (req, res) => { ... });
 */
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      // v4: error.issues (was error.errors in v3)
      const message = result.error.issues.map(e => e.message).join('; ');
      return res.status(400).json({ error: message });
    }
    req.body = result.data;
    next();
  };
}

// ── Shared field definitions ──────────────────────────────────────────────────

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
  .optional();

const latLng = z
  .union([z.number(), z.string().transform(v => (v === '' ? null : parseFloat(v))), z.null()])
  .optional()
  .nullable();

const mediaItem = z.object({
  url:  z.string().min(1),
  type: z.string().optional().nullable(),
});

// ── Posts schemas ─────────────────────────────────────────────────────────────

export const CreatePostSchema = z.object({
  title:         z.string().min(1, 'Title is required'),
  body_markdown: z.string().optional().default(''),
  post_date:     dateString,
  publish:       z.boolean().optional(),
});

export const UpdatePostSchema = z.object({
  title:         z.string().min(1, 'Title is required'),
  body_markdown: z.string().optional(),
  post_date:     dateString,
  // v4: z.literal(false) is redundant inside a union with z.boolean() — simplified
  publish:       z.boolean().optional(),
});

// ── Travel schemas ────────────────────────────────────────────────────────────

export const CreateTravelSchema = z.object({
  title:      z.string().min(1, 'Title is required'),
  location:   z.string().optional().nullable(),
  notes:      z.string().optional().nullable(),
  visitDate:  dateString,
  lat:        latLng,
  lng:        latLng,
  publish:    z.boolean().optional(),
  mediaItems: z.array(mediaItem).optional().default([]),
});

export const UpdateTravelSchema = CreateTravelSchema.extend({
  mediaItems: z.array(mediaItem).optional(),
});

// ── Contact schema ────────────────────────────────────────────────────────────

export const ContactSchema = z.object({
  name:    z.string().min(1, 'Name is required'),
  email:   z.string().email('Invalid email address'),
  message: z.string().min(1, 'Message is required'),
  website: z.string().optional(), // honeypot — presence checked in handler
});

// ── Auth schemas ──────────────────────────────────────────────────────────────

export const SetupSchema = z.object({
  email:    z.string().email('Valid email required'),
  username: z.string().min(1, 'Username is required'),
});

export const EmailSendSchema = z.object({
  email: z.string().email('Valid email required'),
});

export const PasskeyRegisterFinishSchema = z.object({
  response:    z.object({}).passthrough(),
  sessionKey:  z.string().min(1, 'sessionKey is required'),
  passkeyName: z.string().optional(),
});

export const PasskeyLoginFinishSchema = z.object({
  response:   z.object({}).passthrough(),
  sessionKey: z.string().min(1, 'sessionKey is required'),
});
