import { Router } from 'express';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, location, notes, media_url, media_type, lat, lng, created_at FROM travel_memories ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/', authenticate, async (req, res) => {
  try {
    const { title, location, notes, mediaUrl, mediaType, lat, lng } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const latVal = lat !== undefined && lat !== '' ? parseFloat(lat) : null;
    const lngVal = lng !== undefined && lng !== '' ? parseFloat(lng) : null;

    const result = await pool.query(
      `INSERT INTO travel_memories (title, location, notes, media_url, media_type, lat, lng)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title.trim(), location?.trim() || null, notes?.trim() || null, mediaUrl || null, mediaType || null, latVal, lngVal]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM travel_memories WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Memory not found' });
    res.json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
