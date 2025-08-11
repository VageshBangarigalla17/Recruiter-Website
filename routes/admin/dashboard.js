// backend/routes/admin/dashboard.js

const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../../middlewares/authMiddleware');
const { isAdmin } = require('../../middlewares/adminMiddleware');

// Models
const User = require('../../models/User');
const Candidate = require('../../models/Candidate');
const Job = require('../../models/Job'); // <-- Add this if not already imported

/**
 * Main Admin Dashboard
 */
router.get('/', ensureAuthenticated, isAdmin, async (req, res, next) => {
  try {
    const recruiters = await User.find({ role: 'recruiter' }, '_id username').lean();
    const totalCandidates = await Candidate.countDocuments();
    const totalRecruiters = await User.countDocuments({ role: 'recruiter' });

    // Count open positions
    const openPositions = await Job.countDocuments({ status: 'open' });

    res.render('admin/dashboard', {
      recruiters,
      totalCandidates,
      totalRecruiters,
      openPositions,
      user: req.user
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Dashboard data API
 */
router.get('/data', ensureAuthenticated, isAdmin, async (req, res) => {
  try {
    const totalCandidates = await Candidate.countDocuments();
    const totalRecruiters = await User.countDocuments({ role: 'recruiter' });
    const openPositions = await Job.countDocuments({ status: 'open' });

    res.json({ totalCandidates, totalRecruiters, openPositions });
  } catch (err) {
    console.error('Error fetching admin dashboard data:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * Recruiter Performance
 */
router.get('/recruiter/:id', ensureAuthenticated, isAdmin, async (req, res, next) => {
  try {
    const recruiter = await User.findById(req.params.id).lean();
    if (!recruiter) {
      req.flash('error_msg', 'Recruiter not found');
      return res.redirect('/admin/dashboard');
    }
    res.render('admin/recruiter-performance', { recruiter, user: req.user });
  } catch (err) {
    next(err);
  }
});

router.get('/recruiter/:id/data', ensureAuthenticated, isAdmin, async (req, res) => {
  try {
    const recruiterId = req.params.id;
    const totalCandidates = await Candidate.countDocuments({ createdBy: recruiterId });
    const totalSelected = await Candidate.countDocuments({
      createdBy: recruiterId,
      hrStatus: 'Select'
    });

    res.json({ totalCandidates, totalSelected });
  } catch (err) {
    console.error('Error fetching recruiter performance data:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
