import express from 'express';
import { db } from '../database/index.mjs';
import { requireAuth } from '../auth/service.mjs';

const router = express.Router();
const clean = (value, max) => String(value ?? '').trim().slice(0, max);

router.use(requireAuth);
router.get('/', (req, res) => {
  const projects = db.prepare('SELECT id,title,content,type,created_at,updated_at FROM projects WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
  res.json({ projects });
});

router.post('/', (req, res) => {
  const content = clean(req.body?.content, 20000);
  if (!content) return res.status(400).json({ error: 'content_required' });
  const result = db.prepare('INSERT INTO projects(user_id,title,content,type) VALUES(?,?,?,?)').run(req.user.id, clean(req.body?.title, 200) || 'Untitled', content, clean(req.body?.type, 50) || 'Project');
  res.status(201).json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid) });
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid_project_id' });
  const content = clean(req.body?.content, 20000);
  if (!content) return res.status(400).json({ error: 'content_required' });
  const result = db.prepare("UPDATE projects SET title=?,content=?,type=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").run(clean(req.body?.title, 200) || 'Untitled', content, clean(req.body?.type, 50) || 'Project', id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'project_not_found' });
  res.json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(id) });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid_project_id' });
  const result = db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').run(id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'project_not_found' });
  res.json({ ok: true });
});

export default router;
