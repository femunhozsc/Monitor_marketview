const admin = require('firebase-admin');
const { v2: cloudinary } = require('cloudinary');

const serverTimestampMarker = '__serverTimestamp';
const monitorProjectId = process.env.MONITOR_FIREBASE_PROJECT_ID || 'marketview-monitor';
const dataProjectId = process.env.MARKETVIEW_FIREBASE_PROJECT_ID || 'marketview-by-clearview';
const adminEmails = (process.env.ADMIN_EMAILS || 'fernandomunhozsanga@gmail.com')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

function parseServiceAccount(value, name) {
  if (!value) {
    throw new Error(`${name} nao configurada.`);
  }

  try {
    const parsed = JSON.parse(value);
    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    return parsed;
  } catch (error) {
    throw new Error(`${name} deve ser um JSON de service account valido.`);
  }
}

function getAdminApp(name, serviceAccountEnv, projectId) {
  const existing = admin.apps.find((app) => app.name === name);
  if (existing) return existing;

  return admin.initializeApp(
    {
      credential: admin.credential.cert(
        parseServiceAccount(process.env[serviceAccountEnv], serviceAccountEnv),
      ),
      projectId,
    },
    name,
  );
}

function getMonitorApp() {
  return getAdminApp('monitor', 'MONITOR_FIREBASE_SERVICE_ACCOUNT', monitorProjectId);
}

function getDataApp() {
  return getAdminApp('marketview-data', 'MARKETVIEW_FIREBASE_SERVICE_ACCOUNT', dataProjectId);
}

function getDb() {
  return admin.firestore(getDataApp());
}

function configureCloudinary() {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function requireAdmin(req) {
  const authorization = req.headers.authorization || '';
  const match = authorization.match(/^Bearer (.+)$/i);
  if (!match) {
    const error = new Error('Token ausente.');
    error.statusCode = 401;
    throw error;
  }

  if (process.env.REQUIRE_APP_CHECK === 'true') {
    const appCheckToken = req.headers['x-firebase-appcheck'];
    if (!appCheckToken) {
      const error = new Error('Token do App Check ausente.');
      error.statusCode = 401;
      throw error;
    }
    await admin.appCheck(getMonitorApp()).verifyToken(appCheckToken);
  }

  const decoded = await admin.auth(getMonitorApp()).verifyIdToken(match[1]);
  const email = (decoded.email || '').toLowerCase();
  const allowedByClaim = decoded.admin === true;
  const allowedByEmail = adminEmails.includes(email);

  if (!allowedByClaim && !allowedByEmail) {
    const error = new Error('Usuario sem permissao de administrador.');
    error.statusCode = 403;
    throw error;
  }

  return decoded;
}

function validatePath(path, expectedType) {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('Caminho invalido.');
  }
  if (path.includes('..') || path.startsWith('/') || path.endsWith('/')) {
    throw new Error('Caminho invalido.');
  }

  const segments = path.split('/').filter(Boolean);
  if (!segments.length) {
    throw new Error('Caminho invalido.');
  }

  const root = segments[0];
  const allowedRoots = new Set([
    'ads',
    'app_config',
    'chats',
    'community_posts',
    'maintenance_cleanup_queue',
    'review_requests',
    'reviews',
    'stores',
    'users',
  ]);

  if (!allowedRoots.has(root)) {
    throw new Error(`Colecao nao permitida: ${root}`);
  }

  if (expectedType === 'collection' && segments.length % 2 === 0) {
    throw new Error('Era esperado um caminho de colecao.');
  }
  if (expectedType === 'document' && segments.length % 2 !== 0) {
    throw new Error('Era esperado um caminho de documento.');
  }

  return path;
}

function hydrateFirestoreValues(value) {
  if (Array.isArray(value)) {
    return value.map(hydrateFirestoreValues);
  }

  if (value && typeof value === 'object') {
    if (value[serverTimestampMarker] === true) {
      return admin.firestore.FieldValue.serverTimestamp();
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        hydrateFirestoreValues(nestedValue),
      ]),
    );
  }

  return value;
}

function serializeFirestoreValues(value) {
  if (value && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(serializeFirestoreValues);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        serializeFirestoreValues(nestedValue),
      ]),
    );
  }

  return value;
}

async function handleAction(body, actor) {
  const db = getDb();

  switch (body.action) {
    case 'count': {
      const path = validatePath(body.path, 'collection');
      const snapshot = await db.collection(path).count().get();
      return { count: snapshot.data().count };
    }

    case 'getDoc': {
      const path = validatePath(body.path, 'document');
      const snapshot = await db.doc(path).get();
      return {
        exists: snapshot.exists,
        id: snapshot.id,
        data: snapshot.exists ? serializeFirestoreValues(snapshot.data()) : null,
      };
    }

    case 'getDocs': {
      const path = validatePath(body.path, 'collection');
      let query = db.collection(path);

      if (body.orderBy?.field) {
        const direction = body.orderBy.direction === 'asc' ? 'asc' : 'desc';
        query = query.orderBy(body.orderBy.field, direction);
      }

      const requestedLimit = Number(body.limit || 25);
      query = query.limit(Math.min(Math.max(requestedLimit, 1), 200));
      const snapshot = await query.get();

      return {
        docs: snapshot.docs.map((doc) => ({
          id: doc.id,
          data: serializeFirestoreValues(doc.data()),
        })),
      };
    }

    case 'setDoc': {
      const path = validatePath(body.path, 'document');
      const data = hydrateFirestoreValues(body.data || {});
      await db.doc(path).set(data, { merge: body.merge !== false });
      return { ok: true, actor: actor.email || actor.uid };
    }

    case 'updateDoc': {
      const path = validatePath(body.path, 'document');
      const data = hydrateFirestoreValues(body.data || {});
      await db.doc(path).update(data);
      return { ok: true, actor: actor.email || actor.uid };
    }

    case 'deleteDoc': {
      const path = validatePath(body.path, 'document');
      await db.doc(path).delete();
      return { ok: true, actor: actor.email || actor.uid };
    }

    case 'uploadCloudinary': {
      configureCloudinary();
      if (!body.fileDataUrl || !body.folder) {
        throw new Error('Arquivo ou pasta ausente para upload.');
      }

      const upload = await cloudinary.uploader.upload(body.fileDataUrl, {
        folder: String(body.folder),
        resource_type: 'image',
        overwrite: false,
      });

      return {
        secure_url: upload.secure_url,
        url: upload.secure_url,
        public_id: upload.public_id,
      };
    }

    case 'signCloudinaryUpload': {
      if (!body.folder) {
        throw new Error('Pasta ausente para assinatura de upload.');
      }
      if (
        !process.env.CLOUDINARY_CLOUD_NAME ||
        !process.env.CLOUDINARY_API_KEY ||
        !process.env.CLOUDINARY_API_SECRET
      ) {
        throw new Error('Cloudinary nao configurado.');
      }

      const timestamp = Math.round(Date.now() / 1000);
      const folder = String(body.folder);
      const signature = cloudinary.utils.api_sign_request(
        { folder, timestamp },
        process.env.CLOUDINARY_API_SECRET,
      );

      return {
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        apiKey: process.env.CLOUDINARY_API_KEY,
        folder,
        timestamp,
        signature,
      };
    }

    case 'destroyCloudinary': {
      configureCloudinary();
      if (!body.publicId) {
        throw new Error('publicId ausente para remocao.');
      }

      const result = await cloudinary.uploader.destroy(String(body.publicId), {
        resource_type: 'image',
      });
      return { result: result.result };
    }

    default:
      throw new Error(`Acao nao suportada: ${body.action}`);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Metodo nao permitido.' });
  }

  try {
    const actor = await requireAdmin(req);
    const body = await readBody(req);
    const result = await handleAction(body, actor);
    return sendJson(res, 200, result);
  } catch (error) {
    const status = error.statusCode || 500;
    console.error('Erro na API admin:', error);
    return sendJson(res, status, {
      error: error.message || 'Erro interno.',
    });
  }
};
