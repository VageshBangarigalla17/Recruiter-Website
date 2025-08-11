// backend/app.js
require('dotenv').config(); // load env early

const fs = require('fs');
const path = require('path');
const safeRequire = (p) => {
  try { return require(p); } catch (e) { return null; }
};

// ---- Helper: resolve config modules relative to this file ----
const configPath = (...parts) => path.join(__dirname, ...parts);

// ---- Cloudinary (optional) ----
let cloudinary = null;
const cloudinaryPath = configPath('config', 'cloudinary');
if (fs.existsSync(`${cloudinaryPath}.js`)) {
  try {
    cloudinary = require(cloudinaryPath);
    const cloudName = (cloudinary && typeof cloudinary.config === 'function')
      ? (cloudinary.config().cloud_name || '(not-set)')
      : '(no-config-fn)';
    console.log('Cloudinary config OK:', cloudName);
  } catch (err) {
    console.warn('cloudinary require failed:', err.message);
  }
} else {
  console.warn('Warning: cloudinary config file not found at', cloudinaryPath + '.js - continuing without cloudinary.');
}

// ---- Core requires ----
const express        = require('express');
const pathModule     = require('path');
const session        = require('express-session');
const MongoStore     = require('connect-mongo');
const passport       = safeRequire(configPath('config', 'passport')) || require('passport'); // load passport even if strategy file not present
const methodOverride = require('method-override');
const flash          = require('connect-flash');

// Models (paths are relative to backend/)
const User      = safeRequire(path.join(__dirname, 'models', 'User')) || safeRequire(path.join(__dirname, 'models', 'user'));
const Candidate = safeRequire(path.join(__dirname, 'models', 'candidate')) || safeRequire(path.join(__dirname, 'models', 'Candidate'));

// node-fetch dynamic wrapper for Node 18+
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// ---- Connect to MongoDB ----
const dbModulePath = configPath('config', 'db');
const connectDB = safeRequire(dbModulePath);
if (!connectDB) {
  console.error('ERROR: Could not load database connector at', dbModulePath + '.js');
  console.error('Please ensure backend/config/db.js exists and exports a function to connect to MongoDB (e.g. module.exports = async () => { ... })');
  // If you prefer the app to exit on missing DB, uncomment next line:
  // process.exit(1);
} else {
  try {
    connectDB();
    console.log('MongoDB connection triggered (connectDB executed).');
  } catch (err) {
    console.error('connectDB() threw an error:', err);
  }
}

// ---- Passport strategies (optional) ----
const passportSetup = safeRequire(configPath('config', 'passport'));
if (passportSetup && typeof passportSetup === 'function') {
  try {
    passportSetup();
    console.log('Passport strategies loaded.');
  } catch (err) {
    console.warn('Passport setup threw error:', err.message);
  }
} else {
  console.warn('Passport strategy file not found or not a function at', configPath('config', 'passport') + '.js');
}

const app = express();

// ---- Middleware ----
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(pathModule.join(__dirname, 'public')));
app.use(methodOverride('_method'));
app.use('/uploads', express.static(pathModule.join(__dirname, 'public', 'uploads')));

// ---- View engine ----
app.set('view engine', 'ejs');
app.set('views', pathModule.join(__dirname, 'views'));

// ---- Session + Flash ----
const mongoUri = process.env.MONGO_URI || '';
if (!mongoUri) {
  console.warn('Warning: MONGO_URI is not set. Sessions (MongoStore) may fail to initialize.');
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'hrms_secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: mongoUri })
}));
app.use(flash());
app.use((req, res, next) => {
  res.locals.success_msg = req.flash('success_msg');
  res.locals.error_msg   = req.flash('error_msg');
  next();
});

// ---- Passport init ----
app.use(passport.initialize());
app.use(passport.session());

// ---- Make `user` available in views ----
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

const { ensureAuthenticated } = safeRequire(path.join(__dirname, 'middlewares', 'authMiddleware')) || { ensureAuthenticated: (req,res,next)=>next() };

// ---- Routes (safe require) ----
const safeUse = (mount, relPath) => {
  const mod = safeRequire(path.join(__dirname, relPath));
  if (mod) {
    app.use(mount, mod);
  } else {
    console.warn(`Route not mounted: ${mount} -> ${relPath}.js (file missing)`);
  }
};

// Auth routes
safeUse('/', 'routes/auth');

// Landing + dashboard route handlers (keep fallback simple)
app.get('/', (req, res) => {
  if ((req.isAuthenticated && req.isAuthenticated()) || (req.session && req.session.user)) {
    return res.redirect('/dashboard');
  }
  res.render('home');
});

app.get('/dashboard', ensureAuthenticated, async (req, res, next) => {
  try {
    const recruiters = User ? await User.find({ role: 'recruiter' }, '_id username').lean() : [];
    res.render('dashboard', { recruiters, user: req.user });
  } catch (err) {
    next(err);
  }
});

// API for dashboard stats
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
    const totalSelected = Candidate ? await Candidate.countDocuments({ ...filter, hrStatus: 'Select' }) : 0;

    const recruiterCalls = Candidate ? await Candidate.aggregate([
      { $match: filter },
      { $group: { _id: '$createdBy', calls: { $sum: 1 } } },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'recruiter'
        }
      },
      { $unwind: { path: '$recruiter', preserveNullAndEmptyArrays: true } }
    ]) : [];

    const clientCalls = Candidate ? await Candidate.aggregate([
      { $match: filter },
      { $group: { _id: '$client', calls: { $sum: 1 } } },
      { $sort: { calls: -1 } }
    ]) : [];

    res.json({ totalCalls, totalSelected, recruiterCalls, clientCalls });
  } catch (err) {
    console.error('dashboard-stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mount other routes if present
safeUse('/admin/recruiters', 'routes/admin/recruiters');
safeUse('/admin/dashboard', 'routes/admin/dashboard');
safeUse('/candidates', 'routes/candidates');
safeUse('/profile', 'routes/profile');
safeUse('/recruiter', 'routes/recruiter/dashboard');

// 404
app.use((req, res) => res.status(404).render('404'));

// ---- Socket.IO ----
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');

const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });
app.set('io', io);

const PORT = process.env.PORT || 3000;

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('requestStats', async (filters) => {
    try {
      const { recruiterId, date } = filters || {};
      // call local endpoint. On Render this will work since server listens on PORT.
      const base = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
      const url = `${base}/api/dashboard-stats?recruiterId=${encodeURIComponent(recruiterId||'')}&date=${encodeURIComponent(date||'')}`;
      const resApi = await fetch(url);
      const data = await resApi.json();
      socket.emit('statsUpdate', data);
    } catch (err) {
      console.error('Socket stats fetch error:', err);
    }
  });

  socket.on('disconnect', () => console.log('Socket disconnected:', socket.id));
});

// ---- Start server ----
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;
