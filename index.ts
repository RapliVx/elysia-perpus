import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import { staticPlugin } from '@elysiajs/static';
import { jwt } from '@elysiajs/jwt';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';

// --- BACA ENVIRONMENT VARIABLES ---
const JWT_SECRET = process.env.JWT_SECRET as string || 'fallback_secret_sementara_123';
const ADMIN_USER = process.env.ADMIN_USERNAME as string || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD as string || 'admin123';

// 1. OTOMATISASI FOLDER
if (!existsSync('./database')) mkdirSync('./database', { recursive: true });
if (!existsSync('./public/uploads')) mkdirSync('./public/uploads', { recursive: true });

// 2. PEMISAHAN DATABASE
const dbUsers = new Database('./database/users.db', { create: true });
const dbBooks = new Database('./database/books.db', { create: true });
const dbLoans = new Database('./database/loans.db', { create: true });

// Inisialisasi Tabel
dbUsers.query(`CREATE TABLE IF NOT EXISTS users (member_id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'member', photo TEXT DEFAULT '')`).run();
dbBooks.query(`CREATE TABLE IF NOT EXISTS books (book_id TEXT PRIMARY KEY, title TEXT, author TEXT, borrow_count INTEGER DEFAULT 0, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();
dbLoans.query(`CREATE TABLE IF NOT EXISTS loans (loan_id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT, book_id TEXT, loan_date DATETIME DEFAULT CURRENT_TIMESTAMP, status TEXT DEFAULT 'PINJAM')`).run();

// 3. SEEDING DATA & PASSWORD HASHING DARI .ENV
const setupDB = async () => {
  const checkUser = dbUsers.query('SELECT * FROM users WHERE username = $user').get({ $user: ADMIN_USER });
  if (!checkUser) {
    const hash = await Bun.password.hash(ADMIN_PASS);
    dbUsers.query('INSERT INTO users (member_id, username, password, role) VALUES ($id, $user, $password, $role)').run({ 
      $id: 'MEMBER001', $user: ADMIN_USER, $password: hash, $role: 'admin' 
    });
  }

  const checkBooks = dbBooks.query('SELECT COUNT(*) as count FROM books').get() as { count: number };
  if (checkBooks.count === 0) {
    const insertBook = dbBooks.query('INSERT INTO books (book_id, title, author) VALUES ($id, $title, $author)');
    insertBook.run({ $id: 'B001', $title: 'Panduan CachyOS & Arch Linux', $author: 'Sistem' });
    insertBook.run({ $id: 'B002', $title: 'Optimasi Kernel Android (MikuKernel)', $author: 'Sistem' });
    insertBook.run({ $id: 'B003', $title: 'Pemrograman Backend dengan Elysia.js', $author: 'Sistem' });
  }
};
await setupDB();

const app = new Elysia()
  // Keamanan: Security Headers Global (Anti XSS & Clickjacking)
  .onRequest(({ set }) => {
    set.headers['X-Content-Type-Options'] = 'nosniff';
    set.headers['X-Frame-Options'] = 'DENY';
    set.headers['X-XSS-Protection'] = '1; mode=block';
  })
  .use(cors())
  .use(staticPlugin({ assets: 'public', prefix: '/' }))
  
  // MENGGUNAKAN JWT SECRET DARI .ENV
  .use(jwt({ name: 'jwt', secret: JWT_SECRET }))
  
  .get('/', () => Bun.file('public/login.html'))
  
  // --- AUTHENTICATION ENDPOINTS ---
  .post('/api/register', async ({ body }) => {
    const generatedId = 'M-' + Math.floor(1000 + Math.random() * 9000);
    try {
      const hashedPassword = await Bun.password.hash(body.password);
      dbUsers.query('INSERT INTO users (member_id, username, password) VALUES ($id, $user, $pass)').run({ 
        $id: generatedId, $user: body.username, $pass: hashedPassword 
      });
      return { status: "sukses", message: `ID Member: ${generatedId}` };
    } catch (e) { return { status: "gagal", message: "Username sudah terdaftar!" }; }
  }, { 
    body: t.Object({ 
      username: t.String({ minLength: 3, maxLength: 20 }), 
      password: t.String({ minLength: 6, maxLength: 50 }) 
    }) 
  })

  .post('/api/login', async ({ body, jwt, cookie: { auth } }) => {
    const user = dbUsers.query('SELECT * FROM users WHERE username = $u').get({ $u: body.username }) as any;
    if (!user) return { status: "gagal", message: "Username tidak ditemukan!" };

    const isMatch = await Bun.password.verify(body.password, user.password);
    if (!isMatch) return { status: "gagal", message: "Password salah!" };

    auth.set({
      value: await jwt.sign({ id: user.member_id, role: user.role }),
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 7 * 86400,
      path: '/'
    });

    return { status: "sukses", memberId: user.member_id, username: user.username, role: user.role };
  }, { 
    body: t.Object({ username: t.String(), password: t.String() }) 
  })

  .post('/api/logout', ({ cookie: { auth } }) => {
    auth.remove();
    return { status: 'sukses', message: 'Sesi dihancurkan' };
  })

  // --- MIDDLEWARE PENGAMANAN SESI ---
  .derive(async ({ jwt, cookie: { auth } }) => {
    const profile = auth.value ? await jwt.verify(auth.value) : null;
    return { profile };
  })

  // --- ENDPOINT PROTECTED ---
  .guard({
    beforeHandle: ({ profile, set }) => {
      if (!profile) {
        set.status = 401;
        return { status: 'gagal', message: 'Akses ditolak! Sesi tidak valid.' };
      }
    }
  }, app => app
    
    .get('/api/user/:id', ({ params, profile, set }) => {
      if (profile.id !== params.id && profile.role !== 'admin') {
        set.status = 403; return { status: 'gagal', message: 'Akses Ditolak' };
      }
      return dbUsers.query('SELECT member_id, username, role, photo FROM users WHERE member_id = $id').get({ $id: params.id });
    })

    .post('/api/upload-photo', async ({ body, profile, set }) => {
      if (profile.id !== body.memberId && profile.role !== 'admin') {
        set.status = 403; return { status: 'gagal', message: 'Akses Ditolak' };
      }
      const { memberId, photo } = body;
      if (!photo || !photo.type.startsWith('image/')) return { status: 'gagal', message: 'Format harus gambar!' };
      
      const fileName = `${memberId}-${Date.now()}.jpg`;
      await Bun.write(`./public/uploads/${fileName}`, photo);
      const fileUrl = `/uploads/${fileName}`;
      dbUsers.query('UPDATE users SET photo = $p WHERE member_id = $m').run({ $p: fileUrl, $m: memberId });
      return { status: 'sukses', photoUrl: fileUrl };
    }, { body: t.Object({ memberId: t.String(), photo: t.File() }) })

    .get('/api/books/search', ({ query }) => dbBooks.query('SELECT * FROM books WHERE title LIKE $q OR author LIKE $q').all({ $q: `%${query.q || ''}%` }))
    .get('/api/books/latest', () => dbBooks.query('SELECT * FROM books ORDER BY updated_at DESC LIMIT 4').all())
    
    .post('/api/pinjam', ({ body, profile, set }) => {
      if (profile.id !== body.memberId) { set.status = 403; return { status: 'gagal', message: 'Token tidak cocok!' }; }
      const activeLoan = dbLoans.query("SELECT * FROM loans WHERE member_id = $m AND book_id = $b AND status = 'PINJAM'").get({ $m: body.memberId, $b: body.bookId });
      if (activeLoan) return { status: "gagal", message: "Anda masih meminjam buku ini!" };
      
      dbLoans.query("INSERT INTO loans (member_id, book_id) VALUES ($m, $b)").run({ $m: body.memberId, $b: body.bookId });
      dbBooks.query("UPDATE books SET borrow_count = borrow_count + 1, updated_at = CURRENT_TIMESTAMP WHERE book_id = $b").run({ $b: body.bookId });
      return { status: "sukses", message: "Buku berhasil dipinjam!" };
    }, { body: t.Object({ memberId: t.String(), bookId: t.String() }) })
    
    .get('/api/my-loans/:id', ({ params, profile, set }) => {
      if (profile.id !== params.id && profile.role !== 'admin') { set.status = 403; return { status: 'gagal' }; }
      const loans = dbLoans.query(`SELECT loan_id, book_id, loan_date, (strftime('%s','now') - strftime('%s', loan_date)) / 86400 AS days_passed FROM loans WHERE member_id = $id AND status = 'PINJAM'`).all({ $id: params.id }) as any[];
      return loans.map(l => {
        const book = dbBooks.query('SELECT title FROM books WHERE book_id = $b').get({ $b: l.book_id }) as any;
        return { ...l, title: book ? book.title : 'Data Terhapus' };
      });
    })
    
    .post('/api/kembali', ({ body, profile, set }) => {
      const loan = dbLoans.query(`SELECT member_id, (strftime('%s','now') - strftime('%s', loan_date)) / 86400 AS days FROM loans WHERE loan_id = $id`).get({ $id: body.loanId }) as any;
      if (!loan) return { status: 'gagal', message: 'Data tidak ditemukan' };
      if (loan.member_id !== profile.id && profile.role !== 'admin') { set.status = 403; return { status: 'gagal' }; }

      const daysPassed = Math.floor(loan.days);
      const denda = daysPassed > 7 ? (daysPassed - 7) * 2000 : 0;
      dbLoans.query("UPDATE loans SET status = 'KEMBALI' WHERE loan_id = $id").run({ $id: body.loanId });
      return { status: "sukses", message: denda > 0 ? `Terlambat. Denda: Rp ${denda}` : "Kembali tepat waktu!", denda };
    }, { body: t.Object({ loanId: t.Number() }) })

    // --- KEAMANAN ADMIN ---
    .get('/api/admin/stats', ({ profile, set }) => {
      if (profile.role !== 'admin') {
        set.status = 403; return { status: 'gagal', message: 'Akses Ditolak!' };
      }
      return {
        users: dbUsers.query('SELECT COUNT(*) as c FROM users').get() as { c: number },
        books: dbBooks.query('SELECT COUNT(*) as c FROM books').get() as { c: number },
        loans: dbLoans.query("SELECT COUNT(*) as c FROM loans WHERE status = 'PINJAM'").get() as { c: number }
      };
    })
  )

  .listen(3000);

// --- ASCII ART DI TERMINAL ---
const asciiArt = `
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣤⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡦⣤⢔⣊⣞⣛⠃⠲⢄⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠸⡀⢑⠀⠀⠀⠀⣶⢝⣋⠖⣊⠠⠀⢩⠂⢆⠀⠀⠀⠀⠀
⠀⠀⠀⢀⠤⠄⠀⠀⠀⠆⠀⡢⢄⢾⡏⠉⡟⣆⣃⢄⡸⣆⢘⣖⠀⠀⠀⠀
⠀⠀⠀⢐⠖⢢⠀⠁⠀⠀⠉⢀⢣⣹⡇⢁⡼⡉⠉⠙⢧⠆⣀⡕⠢⢤⠀⠀
⠎⢵⡒⠾⠿⠾⣚⣭⡆⠀⠀⢘⣼⣇⣜⠷⡵⣞⢒⣰⡛⣱⡯⠃⢐⠱⠝⠀
⠑⢉⠷⡅⢒⡴⡀⠻⡗⣾⣶⠯⣿⣿⠿⡳⣷⡙⣧⡯⢥⡿⡣⠀⠔⠁⠀⠀
⠰⠑⢯⣎⠉⢉⣷⣭⣍⣞⣽⣿⡛⣿⣿⣿⣷⣯⣟⣝⣾⢵⢫⣶⣄⠀⠀⠀
⠀⠀⠈⢾⡱⣘⠍⣰⣻⠹⠋⡙⢌⡁⡜⡛⠅⠊⡝⡟⢟⠚⢿⣿⣿⡹⡆⠀
⠀⠀⠀⠐⡬⡞⠲⠋⢘⠕⠉⢇⠀⢰⢻⢰⣀⢠⢡⡗⠀⠁⠀⠺⡛⠉⣢⠀
⠀⠀⠀⢰⢱⡅⠃⡁⠁⠀⡔⡜⢷⣭⣉⠧⡀⠹⡸⢥⠀⢀⡠⡋⡄⠀⠈⠄
⠀⠀⠀⠈⠌⣇⠸⠃⢀⠊⣸⣸⣤⣎⠉⠁⠠⠡⢱⣆⣡⣾⣣⠑⢿⣦⢀⠀
⠀⠀⠀⠀⠀⢈⠅⠤⢁⣴⠟⡫⠒⡉⠟⣷⠡⣕⡍⣲⡏⠘⡋⡞⠍⠻⠿⠠
⠀⠀⠀⠀⠀⢸⢸⣼⣿⠗⠁⣠⢚⠔⠛⠀⠉⠛⠹⣍⠧⠐⠁⠀⠀⠀⣀⠀
⠀⠀⠀⠀⠀⢰⡿⠿⢁⢠⠺⠿⠂⠀⠀⠀⠀⠀⢀⢄⠓⠄⡀⠀⡠⠾⠙⠀⠀

🦊 Elysia Perpus Running di http://localhost:3000
Powered By Elysia JS With Bun
`;

console.log(asciiArt);