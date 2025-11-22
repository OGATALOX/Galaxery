// server.js
// Simple image upload + tags app using Express + SQLite + EJS

const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

const cloudinary = require('cloudinary').v2;

// configure using environment variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});


// --- MONGODB (Atlas) ---
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB connection error:", err));

.then(() => console.log("✓ Connected to MongoDB"))
.catch(err => console.error("MongoDB connection error:", err));


const app = express();
const PORT = process.env.PORT || 3000;

// --- MIDDLEWARE ---
app.set('view engine', 'ejs');
app.use(expressLayouts);
app.set('layout', 'layout');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/public', express.static(path.join(__dirname, 'public')));

// ensure uploads folder exists
if (!fs.existsSync(path.join(__dirname, 'uploads'))) fs.mkdirSync(path.join(__dirname, 'uploads'));

// --- MULTER CONFIG ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random()*1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// --- SQLITE DB ---
const db = new sqlite3.Database(path.join(__dirname, 'db.sqlite'));

// promisify db methods
const run = (...args) => new Promise((res, rej) => {
  db.run(...args, function(err){ if(err) rej(err); else res(this); });
});
const get = (sql, params=[]) => new Promise((res, rej) => {
  db.get(sql, params, (err, row) => err ? rej(err) : res(row));
});
const all = (sql, params=[]) => new Promise((res, rej) => {
  db.all(sql, params, (err, rows) => err ? rej(err) : res(rows));
});

// --- INIT TABLES ---
async function initDB(){
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    filename TEXT,
    created_at INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS post_tags (
    post_id INTEGER,
    tag_id INTEGER,
    PRIMARY KEY(post_id, tag_id),
    FOREIGN KEY(post_id) REFERENCES posts(id),
    FOREIGN KEY(tag_id) REFERENCES tags(id)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER,
    post_id INTEGER,
    PRIMARY KEY(user_id, post_id)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER,
    post_id INTEGER,
    PRIMARY KEY(user_id, post_id)
  )`);
}
initDB().catch(console.error);

// --- SESSION ---
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: '.' }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7*24*60*60*1000 } // 1 week
}));

// --- USER ATTACH ---
app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

// --- HELPERS ---
function parseTags(text){
  if(!text) return [];
  const tokens = text.split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.startsWith('#'))
    .map(t => t.replace(/^#+/,'#').toLowerCase());
  return Array.from(new Set(tokens));
}

async function ensureTagIds(tags){
  const ids = [];
  for(const t of tags){
    const row = await get('SELECT id FROM tags WHERE name = ?', [t]);
    if(row) ids.push(row.id);
    else {
      const r = await run('INSERT INTO tags(name) VALUES(?)', [t]);
      ids.push(r.lastID);
    }
  }
  return ids;
}

async function attachTagsToPost(post_id, tag_ids){
  for(const tid of tag_ids){
    await run('INSERT OR IGNORE INTO post_tags(post_id, tag_id) VALUES(?,?)', [post_id, tid]);
  }
}

// --- ROUTES ---

// HOME / SEARCH
app.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page||'1'));
  const limit = 12;
  const offset = (page-1)*limit;
  const sort = req.query.sort === 'oldest' ? 'created_at ASC' : (req.query.sort === 'likes' ? 'likes_count DESC' : 'created_at DESC');

  const tagsQuery = (req.query.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  let posts, totalCount;

  if(tagsQuery.length === 0){
    posts = await all(`SELECT p.*, u.username,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes_count
      FROM posts p
      LEFT JOIN users u ON u.id = p.user_id
      ORDER BY ${sort} LIMIT ? OFFSET ?`, [limit, offset]);
    const c = await get('SELECT COUNT(*) AS c FROM posts');
    totalCount = c.c;
  } else {
    const normTags = tagsQuery.map(t => t.startsWith('#') ? t.toLowerCase() : '#'+t.toLowerCase());
    const placeholders = normTags.map(()=>'?').join(',');
    const tagRows = await all(`SELECT id FROM tags WHERE name IN (${placeholders})`, normTags);
    const tagIds = tagRows.map(r => r.id);
    if(tagIds.length !== normTags.length){
      posts = [];
      totalCount = 0;
    } else {
      posts = await all(`
        SELECT p.*, u.username, (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) as likes_count
        FROM posts p
        JOIN post_tags pt ON pt.post_id = p.id
        JOIN users u ON u.id = p.user_id
        WHERE pt.tag_id IN (${tagIds.map(()=>'?').join(',')})
        GROUP BY p.id
        HAVING COUNT(DISTINCT pt.tag_id) = ?
        ORDER BY ${sort} LIMIT ? OFFSET ?`, [...tagIds, tagIds.length, limit, offset]);
      const total = await get(`SELECT COUNT(*) AS c FROM (
        SELECT p.id
        FROM posts p
        JOIN post_tags pt ON pt.post_id = p.id
        WHERE pt.tag_id IN (${tagIds.map(()=>'?').join(',')})
        GROUP BY p.id
        HAVING COUNT(DISTINCT pt.tag_id) = ?
      ) t`, [...tagIds, tagIds.length]);
      totalCount = total.c;
    }
  }

  for(const p of posts){
    p.tags = (await all(`SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?`, [p.id])).map(r => r.name);
  }

  const popularTags = await all(`
    SELECT t.name, COUNT(pt.post_id) AS cnt
    FROM tags t
    LEFT JOIN post_tags pt ON pt.tag_id = t.id
    GROUP BY t.id
    ORDER BY cnt DESC
    LIMIT 40
  `);

  res.render('index', {
    posts,
    page,
    totalPages: Math.max(1, Math.ceil((totalCount||0)/limit)),
    queryTags: tagsQuery,
    sort: req.query.sort || 'recent',
    popularTags
  });
});

// AUTOCOMPLETE TAGS
app.get('/tags/autocomplete', async (req, res) => {
  const q = (req.query.q||'').toLowerCase();
  if(!q) return res.json([]);
  const normalized = q.startsWith('#') ? q : '#'+q;
  const rows = await all(`
    SELECT t.name, COUNT(pt.post_id) AS cnt
    FROM tags t
    LEFT JOIN post_tags pt ON pt.tag_id = t.id
    WHERE t.name LIKE ?
    GROUP BY t.id
    ORDER BY cnt DESC
    LIMIT 10
  `, [normalized+'%']);
  res.json(rows);
});

// --- UPLOAD / EDIT ---
app.get('/upload', (req, res) => {
  if(!req.session.user) return res.redirect('/login');
  res.render('upload', { user: req.session.user, post: null, tags: [], isEdit: false });
});

app.post('/upload', upload.single('image'), async (req, res) => {
  if(!req.session.user) return res.status(403).send('login required');
  if(!req.file) return res.status(400).send('no file uploaded');

  const tags = parseTags(req.body.tags || '');
  const created_at = Date.now();

  // --- Upload to Cloudinary ---
  const result = await cloudinary.uploader.upload(req.file.path, {
    folder: 'galaxery', // optional folder name
  });

  // result.url contains the permanent image URL
  const filename = result.secure_url;

  const dbResult = await run('INSERT INTO posts(user_id, filename, created_at) VALUES(?,?,?)', [req.session.user.id, filename, created_at]);
  const postId = dbResult.lastID;

  const tagIds = await ensureTagIds(tags);
  await attachTagsToPost(postId, tagIds);

  res.redirect(`/post/${postId}`);
});


app.get('/post/:id/edit', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const postId = Number(req.params.id);
  const post = await get('SELECT * FROM posts WHERE id = ?', [postId]);
  if (!post) return res.status(404).send('Post not found');
  if (post.user_id !== req.session.user.id) return res.status(403).send('not allowed');

  // fetch tags from database
  const tagRows = await all(
    'SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?',
    [postId]
  );
  const tags = tagRows.map(r => r.name); // array of strings

  res.render('upload', { user: req.session.user, post, tags, isEdit: true });
});





// handle edit tags
app.post('/post/:id/edit', async (req, res) => {
  if(!req.session.user) return res.status(401).send('login');

  const post = await get('SELECT * FROM posts WHERE id = ?', [req.params.id]);
  if(!post) return res.status(404).send('not found');
  if(post.user_id !== req.session.user.id) return res.status(403).send('not allowed');

  // DEBUG: see what the server receives
  console.log('POST body tags:', req.body.tags);

  // fallback: if no tags provided, keep old ones
  let tagsInput = req.body.tags;
  if(!tagsInput || tagsInput.trim() === '') {
    const existingTagRows = await all(
      'SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?',
      [post.id]
    );
    tagsInput = existingTagRows.map(r => r.name).join(' ');
  }

  // parse and clean tags
  const tags = parseTags(tagsInput);

  // remove old post_tags
  await run('DELETE FROM post_tags WHERE post_id = ?', [post.id]);

  // ensure tag IDs exist and attach
  const tagIds = await ensureTagIds(tags);
  await attachTagsToPost(post.id, tagIds);

  res.redirect(`/post/${post.id}`);
});









// --- VIEW SINGLE POST ---
app.get('/post/:id', async (req, res) => {
  const id = Number(req.params.id);
  const post = await get('SELECT p.*, u.username FROM posts p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?', [id]);
  if(!post) return res.status(404).send('not found');

  post.tags = (await all('SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?', [id])).map(r=>r.name);

  const likes = await get('SELECT COUNT(*) AS c FROM likes WHERE post_id = ?', [id]);
  const liked = req.session.user ? await get('SELECT 1 FROM likes WHERE post_id=? AND user_id=?', [id, req.session.user.id]) : null;
  const favorited = req.session.user ? await get('SELECT 1 FROM favorites WHERE post_id=? AND user_id=?', [id, req.session.user.id]) : null;

  res.render('post', { post, likes: likes.c, liked: !!liked, favorited: !!favorited });
});

// --- LIKE / FAVORITE ---
app.post('/post/:id/like', async (req,res)=>{
  if(!req.session.user) return res.status(401).json({error:'login'});
  const postId = Number(req.params.id);
  const exists = await get('SELECT 1 FROM likes WHERE user_id=? AND post_id=?', [req.session.user.id, postId]);
  if(exists) await run('DELETE FROM likes WHERE user_id=? AND post_id=?', [req.session.user.id, postId]);
  else await run('INSERT INTO likes(user_id, post_id) VALUES(?,?)', [req.session.user.id, postId]);
  const likes = await get('SELECT COUNT(*) AS c FROM likes WHERE post_id=?', [postId]);
  res.json({ likes: likes.c });
});

app.post('/post/:id/fav', async (req,res)=>{
  if(!req.session.user) return res.status(401).json({error:'login'});
  const postId = Number(req.params.id);
  const exists = await get('SELECT 1 FROM favorites WHERE user_id=? AND post_id=?', [req.session.user.id, postId]);
  if(exists) await run('DELETE FROM favorites WHERE user_id=? AND post_id=?', [req.session.user.id, postId]);
  else await run('INSERT INTO favorites(user_id, post_id) VALUES(?,?)', [req.session.user.id, postId]);
  res.json({ ok:true });
});

// --- DELETE POST ---
app.post('/post/:id/delete', async (req,res)=>{
  if(!req.session.user) return res.status(401).send('login');
  const post = await get('SELECT * FROM posts WHERE id=?', [req.params.id]);
  if(!post) return res.status(404).send('not found');
  if(post.user_id !== req.session.user.id) return res.status(403).send('not allowed');

  try { fs.unlinkSync(path.join(__dirname,'uploads',post.filename)); } catch(e){}

  await run('DELETE FROM post_tags WHERE post_id=?', [post.id]);
  await run('DELETE FROM posts WHERE id=?', [post.id]);
  res.redirect('/myposts');
});

// --- AUTH ---
app.get('/register', (req,res)=>res.render('register'));
app.post('/register', async (req,res)=>{
  const username = (req.body.username||'').trim();
  const password = req.body.password||'';
  if(!username||!password) return res.render('register',{error:'fill both'});
  const hashed = await bcrypt.hash(password,10);
  try{
    const r = await run('INSERT INTO users(username,password) VALUES(?,?)',[username,hashed]);
    req.session.user = {id:r.lastID, username};
    res.redirect('/');
  }catch(e){
    res.render('register',{error:'username taken'});
  }
});

app.get('/login', (req,res)=>res.render('login'));
app.post('/login', async (req,res)=>{
  const username = (req.body.username||'').trim();
  const password = req.body.password||'';
  const user = await get('SELECT * FROM users WHERE username=?',[username]);
  if(!user) return res.render('login',{error:'invalid'});
  const ok = await bcrypt.compare(password,user.password);
  if(!ok) return res.render('login',{error:'invalid'});
  req.session.user = {id:user.id, username:user.username};
  res.redirect('/');
});

app.get('/logout', (req,res)=>{
  req.session.destroy(()=>res.redirect('/'));
});

// --- USER PAGES ---
app.get('/user/:id', async (req,res)=>{
  const uid = Number(req.params.id);
  const user = await get('SELECT id, username FROM users WHERE id=?',[uid]);
  if(!user) return res.status(404).send('no user');
  const posts = await all('SELECT p.*, (SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id) AS likes_count FROM posts p WHERE p.user_id=? ORDER BY created_at DESC',[uid]);
  for(const p of posts) p.tags = (await all('SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id=t.id WHERE pt.post_id=?',[p.id])).map(r=>r.name);
  res.render('user',{user,posts});
});

// --- MY POSTS ---
app.get('/myposts', async (req,res)=>{
  if(!req.session.user) return res.redirect('/login');
  const posts = await all('SELECT p.*, (SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id) AS likes_count FROM posts p WHERE p.user_id=? ORDER BY created_at DESC',[req.session.user.id]);
  for(const p of posts) p.tags = (await all('SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id=t.id WHERE pt.post_id=?',[p.id])).map(r=>r.name);
  res.render('myposts',{posts});
});

// --- FAVORITES ---
app.get('/favorites', async (req,res)=>{
  if(!req.session.user) return res.redirect('/login');
  const posts = await all(`
    SELECT p.*, u.username, (SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id) AS likes_count
    FROM posts p
    JOIN favorites f ON f.post_id=p.id
    LEFT JOIN users u ON u.id=p.user_id
    WHERE f.user_id=?
    ORDER BY p.created_at DESC
  `,[req.session.user.id]);
  for(const p of posts) p.tags = (await all('SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id=t.id WHERE pt.post_id=?',[p.id])).map(r=>r.name);
  res.render('favorites',{posts});
});

// --- TAG REDIRECT ---
app.get('/tag/:name', (req,res)=>{
  const t = req.params.name.startsWith('#') ? req.params.name : '#'+req.params.name;
  res.redirect('/?tags='+encodeURIComponent(t));
});

// --- HEALTH CHECK ---
app.get('/ping',(req,res)=>res.send('ok'));

// --- START SERVER ---
app.listen(PORT, ()=>console.log('Listening on', PORT));
