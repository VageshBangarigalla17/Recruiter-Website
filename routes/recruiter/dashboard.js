// backend/routes/recruiter/dashboard.js

const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../../middlewares/authMiddleware');
const recruiterDashboardCtrl = require('../../controllers/recruiterDashboardController');

/**
 * Recruiter Self Performance Dashboard
 */
router.get(
  '/',
  ensureAuthenticated,
  recruiterDashboardCtrl.renderSelfDashboard
);

router.get(
  '/data',
  ensureAuthenticated,
  recruiterDashboardCtrl.getSelfDashboardData
);

module.exports = router;
