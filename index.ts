import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import { staticPlugin } from '@elysiajs/static';
import { jwt } from '@elysiajs/jwt';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, unlinkSync } from 'fs'; 

const JWT_SECRET = process.env.JWT_SECRET as string || 'fallback_secret_sementara_123';
const ADMIN_USER = process.env.ADMIN_USERNAME as string || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD as string || 'admin123';

if (!existsSync('./database')) mkdirSync('./database', { recursive: true });
if (!existsSync('./public/uploads')) mkdirSync('./public/uploads', { recursive: true });
if (!existsSync('./public/covers')) mkdirSync('./public/covers', { recursive: true });

const dbUsers = new Database('./database/users.db', { create: true });
dbUsers.exec("PRAGMA journal_mode = WAL;");
const dbBooks = new Database('./database/books.db', { create: true });
dbBooks.exec("PRAGMA journal_mode = WAL;");
const dbLoans = new Database('./database/loans.db', { create: true });
dbLoans.exec("PRAGMA journal_mode = WAL;");

dbUsers.query(`CREATE TABLE IF NOT EXISTS users (member_id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'member', photo TEXT DEFAULT '')`).run();
dbBooks.query(`CREATE TABLE IF NOT EXISTS books (book_id TEXT PRIMARY KEY, title TEXT, author TEXT, cover_image TEXT DEFAULT '', borrow_count INTEGER DEFAULT 0, stock INTEGER DEFAULT 1, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();
dbLoans.query(`CREATE TABLE IF NOT EXISTS loans (loan_id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT, book_id TEXT, loan_date DATETIME DEFAULT CURRENT_TIMESTAMP, status TEXT DEFAULT 'PINJAM')`).run();

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
    const insertBook = dbBooks.query('INSERT INTO books (book_id, title, author, stock) VALUES ($id, $title, $author, $stock)');
    insertBook.run({ $id: 'EP-10001', $title: 'Panduan CachyOS & Arch Linux', $author: 'Sistem', $stock: 5 });
    insertBook.run({ $id: 'EP-10002', $title: 'Optimasi Kernel Android', $author: 'Sistem', $stock: 3 });
    insertBook.run({ $id: 'EP-10003', $title: 'Pemrograman Backend dengan Elysia.js', $author: 'Sistem', $stock: 10 });
  }
};
await setupDB();

const app = new Elysia()
  .onRequest(({ set }) => {
    set.headers['X-Content-Type-Options'] = 'nosniff';
    set.headers['X-Frame-Options'] = 'DENY';
    set.headers['X-XSS-Protection'] = '1; mode=block';
    set.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
    set.headers['Referrer-Policy'] = 'no-referrer-when-downgrade';
    set.headers['Permissions-Policy'] = 'geolocation=(), microphone=(), camera=()';
  })
  .use(cors())
  .use(staticPlugin({ assets: 'public', prefix: '/' }))
  .use(jwt({ name: 'jwt', secret: JWT_SECRET }))
  
  .get('/', () => Bun.file('public/login.html'))
  
  .post('/api/register', async ({ body }) => {
    const generatedId = 'M-' + Math.floor(1000 + Math.random() * 9000);
    try {
      const hashedPassword = await Bun.password.hash(body.password);
      dbUsers.query('INSERT INTO users (member_id, username, password) VALUES ($id, $user, $pass)').run({ 
        $id: generatedId, $user: body.username, $pass: hashedPassword 
      });
      return { status: "sukses", message: `ID Member: ${generatedId}` };
    } catch (e) { return { status: "gagal", message: "Username sudah terdaftar!" }; }
  }, { body: t.Object({ username: t.String({ minLength: 3, maxLength: 20 }), password: t.String({ minLength: 6, maxLength: 50 }) }) })

  .post('/api/login', async ({ body, jwt, cookie: { auth } }) => {
    const user = dbUsers.query('SELECT * FROM users WHERE username = $u').get({ $u: body.username }) as any;
    if (!user) return { status: "gagal", message: "Username tidak ditemukan!" };

    const isMatch = await Bun.password.verify(body.password, user.password);
    if (!isMatch) return { status: "gagal", message: "Password salah!" };

    auth.set({ value: await jwt.sign({ id: user.member_id, role: user.role }), httpOnly: true, sameSite: 'strict', maxAge: 7 * 86400, path: '/' });
    return { status: "sukses", memberId: user.member_id, username: user.username, role: user.role };
  }, { body: t.Object({ username: t.String(), password: t.String() }) })

  .post('/api/logout', ({ cookie: { auth } }) => {
    auth.remove(); return { status: 'sukses', message: 'Sesi dihancurkan' };
  })

  .derive(async ({ jwt, cookie: { auth } }) => {
    const profile = auth.value ? await jwt.verify(auth.value) : null;
    return { profile };
  })

  .guard({
    beforeHandle: ({ profile, set }) => {
      if (!profile) { set.status = 401; return { status: 'gagal', message: 'Sesi tidak valid.' }; }
    }
  }, app => app
    
    .get('/api/user/:id', ({ params, profile, set }) => {
      if (profile.id !== params.id && profile.role !== 'admin') { set.status = 403; return { status: 'gagal' }; }
      return dbUsers.query('SELECT member_id, username, role, photo FROM users WHERE member_id = $id').get({ $id: params.id });
    })

    .post('/api/upload-photo', async ({ body, profile, set }) => {
      if (profile.id !== body.memberId && profile.role !== 'admin') { set.status = 403; return { status: 'gagal' }; }
      const { memberId, photo } = body;
      if (!photo || !photo.type.startsWith('image/')) return { status: 'gagal', message: 'Format salah!' };
      
      const oldUser = dbUsers.query('SELECT photo FROM users WHERE member_id = $m').get({ $m: memberId }) as any;
      if (oldUser && oldUser.photo) {
        const oldPath = `./public${oldUser.photo}`; 
        if (existsSync(oldPath)) {
          try { unlinkSync(oldPath); } catch (e) { }
        }
      }

      const fileName = `pfp-${memberId}-${Date.now()}.jpg`;
      await Bun.write(`./public/uploads/${fileName}`, photo);
      const fileUrl = `/uploads/${fileName}`;
      dbUsers.query('UPDATE users SET photo = $p WHERE member_id = $m').run({ $p: fileUrl, $m: memberId });
      return { status: 'sukses', photoUrl: fileUrl };
    }, { body: t.Object({ memberId: t.String(), photo: t.File() }) })

    .get('/api/books/search', ({ query }) => dbBooks.query('SELECT * FROM books WHERE title LIKE $q OR author LIKE $q OR book_id LIKE $q').all({ $q: `%${query.q || ''}%` }))
    .get('/api/books/latest', () => dbBooks.query('SELECT * FROM books ORDER BY updated_at DESC').all())
    
    .post('/api/pinjam', ({ body, profile, set }) => {
      if (profile.id !== body.memberId) { set.status = 403; return { status: 'gagal' }; }
      
      const bookInfo = dbBooks.query('SELECT stock FROM books WHERE book_id = $b').get({ $b: body.bookId }) as any;
      if(!bookInfo || bookInfo.stock <= 0) return { status: "gagal", message: "Maaf, stok buku sedang habis!" };

      const activeLoan = dbLoans.query("SELECT * FROM loans WHERE member_id = $m AND book_id = $b AND status = 'PINJAM'").get({ $m: body.memberId, $b: body.bookId });
      if (activeLoan) return { status: "gagal", message: "Anda masih meminjam buku ini!" };
      
      dbLoans.query("INSERT INTO loans (member_id, book_id) VALUES ($m, $b)").run({ $m: body.memberId, $b: body.bookId });
      dbBooks.query("UPDATE books SET borrow_count = borrow_count + 1, stock = stock - 1, updated_at = CURRENT_TIMESTAMP WHERE book_id = $b").run({ $b: body.bookId });
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
      const loan = dbLoans.query(`SELECT member_id, book_id, (strftime('%s','now') - strftime('%s', loan_date)) / 86400 AS days FROM loans WHERE loan_id = $id`).get({ $id: body.loanId }) as any;
      if (!loan) return { status: 'gagal', message: 'Data tidak ditemukan' };
      if (loan.member_id !== profile.id && profile.role !== 'admin') { set.status = 403; return { status: 'gagal' }; }

      const daysPassed = Math.floor(loan.days);
      const denda = daysPassed > 7 ? (daysPassed - 7) * 2000 : 0;
      
      dbLoans.query("UPDATE loans SET status = 'KEMBALI' WHERE loan_id = $id").run({ $id: body.loanId });
      dbBooks.query("UPDATE books SET stock = stock + 1 WHERE book_id = $b").run({ $b: loan.book_id });
      
      return { status: "sukses", message: denda > 0 ? `Terlambat! Denda: Rp ${denda.toLocaleString('id-ID')}` : "Kembali tepat waktu!", denda };
    }, { body: t.Object({ loanId: t.Number() }) })

    .guard({
      beforeHandle: ({ profile, set }) => {
        if (profile.role !== 'admin') { set.status = 403; return { status: 'gagal', message: 'Akses Ditolak!' }; }
      }
    }, adminApp => adminApp
      
      .get('/api/admin/stats', () => ({
        users: dbUsers.query('SELECT COUNT(*) as c FROM users').get() as { c: number },
        books: dbBooks.query('SELECT COUNT(*) as c FROM books').get() as { c: number },
        loans: dbLoans.query("SELECT COUNT(*) as c FROM loans WHERE status = 'PINJAM'").get() as { c: number }
      }))

      .post('/api/admin/books', async ({ body }) => {
        const uniqueSerial = Math.floor(10000 + Math.random() * 90000);
        const generatedId = `EP-${uniqueSerial}`;
        let coverUrl = '';
        if (body.cover && body.cover.size > 0 && body.cover.type.startsWith('image/')) {
          const fileName = `cover-${generatedId}.jpg`;
          await Bun.write(`./public/covers/${fileName}`, body.cover);
          coverUrl = `/covers/${fileName}`;
        }
        const stock = parseInt(body.stock) || 1;
        dbBooks.query('INSERT INTO books (book_id, title, author, cover_image, stock) VALUES ($id, $title, $author, $cover, $stock)').run({ 
          $id: generatedId, $title: body.title, $author: body.author, $cover: coverUrl, $stock: stock 
        });
        return { status: "sukses" };
      }, { body: t.Object({ title: t.String(), author: t.String(), stock: t.String(), cover: t.Optional(t.File()) }) })

      .get('/api/admin/users', () => dbUsers.query('SELECT member_id, username, role, photo FROM users ORDER BY role ASC').all())
      
      .post('/api/admin/users/:id/password', async ({ params, body }) => {
        const hashedPassword = await Bun.password.hash(body.newPassword);
        dbUsers.query('UPDATE users SET password = $p WHERE member_id = $id').run({ $p: hashedPassword, $id: params.id });
        return { status: "sukses" };
      }, { body: t.Object({ newPassword: t.String({ minLength: 6 }) }) })

      .delete('/api/admin/users/:id', ({ params, profile, set }) => {
        if(params.id === profile.id) { set.status = 400; return { status: "gagal", message: "Tidak bisa menghapus akun sendiri!" }; }
        dbUsers.query('DELETE FROM users WHERE member_id = $id').run({ $id: params.id });
        return { status: "sukses" };
      })

      .post('/api/admin/loans/:id/simulate-time', ({ params, body }) => {
        const shift = body.days;
        const modifier = shift >= 0 ? `-${shift} days` : `+${Math.abs(shift)} days`;
        
        dbLoans.query(`UPDATE loans SET loan_date = datetime(loan_date, '${modifier}') WHERE loan_id = $id`).run({ $id: params.id });
        return { status: "sukses" };
      }, { body: t.Object({ days: t.Number() }) })
    )
  )

  .listen(3000, (server) => {
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

🦊 Elysia Perpus is Running!
🔗 Access: http://${server.hostname}:${server.port}
🚀 Powered By Elysia JS With Bun
    `;
    console.log(asciiArt);
  });