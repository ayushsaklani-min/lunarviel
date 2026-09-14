const DATABASE = "lunarveil-owner-vault-v1";
const KEY_STORE = "keys";
const SECRET_STORE = "secrets";
const KEY_ID = "owner-vault-key";

const memoryFallback = new Map<string, Uint8Array>();

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer as ArrayBuffer;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => { resolve(value.result); };
    value.onerror = () => { reject(value.error ?? new Error("OWNER_VAULT_FAILED")); };
  });
}

async function database(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const open = indexedDB.open(DATABASE, 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
    if (!db.objectStoreNames.contains(SECRET_STORE)) db.createObjectStore(SECRET_STORE);
  };
  return request(open);
}

async function vaultKey(db: IDBDatabase): Promise<CryptoKey> {
  const read = db.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).get(KEY_ID);
  const existing = await request(read) as CryptoKey | undefined;
  if (existing !== undefined) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const transaction = db.transaction(KEY_STORE, "readwrite");
  transaction.objectStore(KEY_STORE).put(key, KEY_ID);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => { resolve(); };
    transaction.onerror = () => { reject(transaction.error ?? new Error("OWNER_VAULT_FAILED")); };
  });
  return key;
}

export async function retainOwnerSecretV1(commitment: string, secret: Uint8Array): Promise<void> {
  const db = await database();
  if (db === undefined) { memoryFallback.set(commitment, Uint8Array.from(secret)); return; }
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await vaultKey(db), arrayBuffer(secret));
    const transaction = db.transaction(SECRET_STORE, "readwrite");
    transaction.objectStore(SECRET_STORE).put({ iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)) }, commitment);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("OWNER_VAULT_FAILED")); };
    });
    iv.fill(0);
  } finally { db.close(); }
}

export async function ownerSecretForCancellationV1(commitment: string): Promise<Uint8Array | undefined> {
  const db = await database();
  if (db === undefined) {
    const secret = memoryFallback.get(commitment);
    return secret === undefined ? undefined : Uint8Array.from(secret);
  }
  try {
    const row = await request(db.transaction(SECRET_STORE, "readonly").objectStore(SECRET_STORE).get(commitment)) as { iv: number[]; ciphertext: number[] } | undefined;
    if (row === undefined) return undefined;
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(row.iv) }, await vaultKey(db), arrayBuffer(Uint8Array.from(row.ciphertext)));
    return new Uint8Array(clear);
  } finally { db.close(); }
}
