// backend/app.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const methodOverride = require('method-override');
const flash = require('connect-flash');
const http = require('http');
const { Server } = require('socket.io');

// Helper: safe require
const safeRequire = (filePath) => {
  try {
    return require(filePath);
  } catch {
    return null;
  }
};

// Path helper
const configPath = (...parts) => path.join(__dirname, ...parts);

// Optional Cloudinary
if (fs.existsSync(configPath('config', 'cloudinary.js'))) {
  try {
    require(configPath('config', 'cloudinary'));
    console.log('Cloudinary config OK');
  } catch (err) {
    console.warn('Cloudinary load error:', err.message);
  }
} else {
  console.warn('Cloudinary config not found.');
}

// Connect DB
const connectDB = safeRequire(configPath('config', 'db'));
if (typeof connectDB === 'function') {
  connectDB();
} else {
  console.error('Database connection file missing at config/db.js');
  process.exit(1);
}

// Passport setup
const passportSetup = safeRequire(configPath('config', 'passport'));
if (typeof passportSetup === 'function') {
  passportSetup(passport);
} else {
  console.warn('Passport config missing.');
}

// Models
const User = safeRequire(path.join(__dirname, 'models', 'User'));
const Candidate = safeRequire(path.join(__dirname, 'models', 'Candidate'));

// Init app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(methodOverride('_method'));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Sessions
if (!process.env.MONGO_URI) {
  console.error('MONGO_URI not set in .env');
  process.exit(1);
}

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'hrms_secret',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
  })
);

app.use(flash());
app.use((req, res, next) => {
  res.locals.success_msg = req.flash('success_msg');
  res.locals.error_msg = req.flash('error_msg');
  next();
});

// Passport
app.use(passport.initialize());
app.use(passport.session());

// Make `user` available in views
app.use(async (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    res.locals.user = req.user;
  } else if (req.session?.user?.id && User) {
    try {
      const user = await User.findById(req.session.user.id);
      if (user) {
        req.user = user;
        res.locals.user = user;
      }
    } catch (err) {
      console.error('Session user load error:', err);
    }
  } else {
    res.locals.user = null;
  }
  next();
});

// Auth middleware
const { ensureAuthenticated } =
  safeRequire(path.join(__dirname, 'middlewares', 'authMiddleware')) || {
    ensureAuthenticated: (req, res, next) => next(),
  };

// Helper to mount routes
const safeUse = (mount, relPath) => {
  const mod = safeRequire(path.join(__dirname, relPath));
  if (mod) {
    app.use(mount, mod);
    console.log(`✅ Route loaded: ${mount} -> ${relPath}.js`);
  } else {
    console.warn(`⚠️ Route not found: ${mount} (missing ${relPath}.js)`);
  }
};

// ===== ROUTES =====
safeUse('/', 'routes/auth');
safeUse('/admin/recruiters', 'routes/admin/recruiters');
safeUse('/admin/dashboard', 'routes/admin/dashboard');
safeUse('/candidates', 'routes/candidates');
safeUse('/profile', 'routes/profile');
safeUse('/recruiter', 'routes/recruiter/dashboard');

// Home page
app.get('/', (req, res) => {
  if ((req.isAuthenticated && req.isAuthenticated()) || (req.session && req.session.user)) {
    return res.redirect('/dashboard');
  }
  res.render('home');
});

// Dashboard page (FIXED with totalCandidates and totalRecruiters)
app.get('/dashboard', ensureAuthenticated, async (req, res, next) => {
  try {
    const totalCandidates = Candidate ? await Candidate.countDocuments() : 0;
    const totalRecruiters = User ? await User.countDocuments({ role: 'recruiter' }) : 0;
    const recruiters = User
      ? await User.find({ role: 'recruiter' }, '_id username').lean()
      : [];

    res.render('admin/dashboard', {
      totalCandidates,
      totalRecruiters,
      recruiters,
      user: req.user
    });
  } catch (err) {
    next(err);
  }
});

// Dashboard stats API
app.get('/api/dashboard-stats', ensureAuthenticated, async (req, res) => {
  try {
    const { recruiterId, date } = req.query;
    const filter = {};
    const start = date ? new Date(date) : new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    filter.createdAt = { $gte: start, $lte: end };
    if (recruiterId) filter.createdBy = recruiterId;

    const totalCalls = Candidate ? await Candidate.countDocuments(filter) : 0;
    const totalSelected = Candidate
      ? await Candidate.countDocuments({ ...filter, hrStatus: 'Select' })
      : 0;

    const recruiterCalls = Candidate
      ? await Candidate.aggregate([
          { $match: filter },
          { $group: { _id: '$createdBy', calls: { $sum: 1 } } },
          {
            $lookup: {
              from: 'users',
              localField: '_id',
              foreignField: '_id',
              as: 'recruiter',
            },
          },
          { $unwind: { path: '$recruiter', preserveNullAndEmptyArrays: true } },
        ])
      : [];

    const clientCalls = Candidate
      ? await Candidate.aggregate([
          { $match: filter },
          { $group: { _id: '$client', calls: { $sum: 1 } } },
          { $sort: { calls: -1 } },
        ])
      : [];

    res.json({ totalCalls, totalSelected, recruiterCalls, clientCalls });
  } catch (err) {
    console.error('dashboard-stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 404 handler
app.use((req, res) => res.status(404).render('404'));

// ===== SOCKET.IO =====
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});
app.set('io', io);

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('requestStats', async (filters) => {
    try {
      const { recruiterId, date } = filters || {};
      const base =
        process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
      const resApi = await fetch(
        `${base}/api/dashboard-stats?recruiterId=${encodeURIComponent(recruiterId || '')}&date=${encodeURIComponent(date || '')}`
      );
      const data = await resApi.json();
      socket.emit('statsUpdate', data);
    } catch (err) {
      console.error('Socket stats fetch error:', err);
    }
  });

  socket.on('disconnect', () => console.log('Socket disconnected:', socket.id));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;
