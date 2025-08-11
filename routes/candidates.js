// backend/routes/candidates.js

const express = require('express');
const router = express.Router();
const upload = require('../config/multerCloudinary');
const candidateCtrl = require('../controllers/candidateController');
const { ensureAuthenticated } = require('../middlewares/authMiddleware');

/**
 * Export candidates routes
 */
router.get(
  '/export',
  ensureAuthenticated,
  candidateCtrl.exportCandidates
);

router.post(
  '/export/download',
  ensureAuthenticated,
  candidateCtrl.exportSelected
);

/**
 * CRUD routes
 */
// List all candidates
router.get('/', ensureAuthenticated, candidateCtrl.getAllCandidates);

// Show add candidate form
router.get('/new', ensureAuthenticated, (req, res) => {
  res.render('candidates/new');
});

// Create candidate
router.post('/', ensureAuthenticated, upload.single('resume'), candidateCtrl.createCandidate);

// Show candidate details
router.get('/:id', ensureAuthenticated, candidateCtrl.getCandidateById, (req, res) => {
  res.render('candidates/show', { candidate: res.locals.candidate });
});

// Edit candidate form
router.get('/:id/edit', ensureAuthenticated, candidateCtrl.getCandidateById, (req, res) => {
  res.render('candidates/edit', { candidate: res.locals.candidate });
});

// Update candidate
router.post('/:id', ensureAuthenticated, upload.single('resume'), candidateCtrl.updateCandidate);

// Delete candidate
router.post('/:id/delete', ensureAuthenticated, candidateCtrl.deleteCandidate);

/**
 * Download resume
 */
router.get('/:id/download', ensureAuthenticated, candidateCtrl.downloadResume);

module.exports = router;
