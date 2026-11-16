// Налаштування Firebase. Встав сюди блок firebaseConfig з консолі Firebase
// (Project settings → General → Your apps → Web app).
// Поки apiKey порожній, гра працює в ДЕМО-режимі: дані живуть лише в цьому браузері
// (вкладки синхронізуються між собою), щоб можна було подивитись інтерфейс.
export const firebaseConfig = {
  apiKey: "AIzaSyCh3DBLppnshVCdkh7zkBhWqEz7LWogIHI",
  authDomain: "kvitka-rpg.firebaseapp.com",
  // Адреса Realtime Database (регіон europe-west1). Якщо базу створено в іншому регіоні —
  // скопіюйте адресу з вкладки Data в консолі Firebase.
  databaseURL: "https://kvitka-rpg-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "kvitka-rpg",
  storageBucket: "kvitka-rpg.firebasestorage.app",
  messagingSenderId: "909111539534",
  appId: "1:909111539534:web:7ea4f0bac7dbfa4e0c101f"
};
