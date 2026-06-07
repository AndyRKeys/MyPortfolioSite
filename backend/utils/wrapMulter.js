import multer from 'multer';

// Returns middleware that runs a pre-bound multer call (e.g. upload.single('file'))
// and converts MulterError / fileFilter rejections to 400 JSON so route handlers
// can assume req.file is already populated when they run.
export function wrapMulter(multerFn) {
  return (req, res, next) => {
    multerFn(req, res, (err) => {
      if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  };
}
