const { BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');
const sharp = require('sharp');
const axios = require('axios');

async function useMongoDBAuthState(collection) {
    const writeData = async (data, id) => {
        const json = JSON.stringify(data, BufferJSON.replacer);
        await collection.updateOne({ _id: id }, { $set: { data: json, updatedAt: new Date() } }, { upsert: true });
    };

    const readData = async (id) => {
        try {
            const res = await collection.findOne({ _id: id });
            return res ? JSON.parse(res.data, BufferJSON.reviver) : null;
        } catch { return null; }
    };

    const removeData = async (id) => {
        try { await collection.deleteOne({ _id: id }); } catch {}
    };

    try {
        const sieteDiasAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        await collection.deleteMany({ updatedAt: { $lt: sieteDiasAtras }, _id: { $ne: 'creds' } });
    } catch {}

    const creds = (await readData('creds')) || (initAuthCreds(), await writeData(initAuthCreds(), 'creds'), initAuthCreds());

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) data[id] = await readData(`${type}-${id}`);
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const cat of Object.keys(data)) {
                        for (const id of Object.keys(data[cat])) {
                            const val = data[cat][id], key = `${cat}-${id}`;
                            tasks.push(val ? writeData(val, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

async function obtenerGifAleatorio(query, backupUrl) {
    try {
        if (process.env.GIPHY_API_KEY) {
            const res = await axios.get(`https://api.giphy.com/v1/gifs/search?api_key=${process.env.GIPHY_API_KEY}&q=${query}&limit=15&rating=g`);
            const gifs = res.data.data;
            if (gifs.length > 0) {
                const url = gifs[Math.floor(Math.random() * gifs.length)].images.downsized_medium.url;
                const r = await axios.get(url, { responseType: 'arraybuffer' });
                return await sharp(Buffer.from(r.data), { animated: true }).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 50, effort: 2 }).toBuffer();
            }
        }
    } catch {}

    try {
        const r = await axios.get(backupUrl, { responseType: 'arraybuffer' });
        return await sharp(Buffer.from(r.data), { animated: true }).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 50, effort: 2 }).toBuffer();
    } catch { return null; }
}

function calcularDiasFaltantes(fechaStr) {
    if (!fechaStr) return 999;
    const [dia, mes] = fechaStr.split('/').map(Number);
    const hoyPeru = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Lima" }));
    let proximo = new Date(hoyPeru.getFullYear(), mes - 1, dia);

    if (proximo < hoyPeru && (proximo.getMonth() !== hoyPeru.getMonth() || proximo.getDate() !== hoyPeru.getDate())) {
        proximo.setFullYear(hoyPeru.getFullYear() + 1);
    }
    return Math.ceil((proximo - hoyPeru) / (1000 * 60 * 60 * 24));
}

function esOwner(sender) {
    return sender.includes('275028952228088') || sender.includes('51924876085');
}

async function handleCommand(ctx) {
    const {
        sock, m, from, sender, args, command, messageType,
        usersCollection, groupsCollection, remindersCollection, // <--- AQUÍ DEBE ESTAR
        bankCollection, groupStatsCollection, state, deps, esOwner
    } = ctx;

    const {
        axios, sharp, pino, gtts, fs, path, os, downloadMediaMessage, obtenerGifAleatorio, calcularDiasFaltantes
    } = deps;

    if (command === 'ping' || command === 'p') {
        await sock.sendMessage(from, { text: '¡Pong! 🏓 CocoBot activo y en línea.' }, { quoted: m });
        return true;
    }

    if (command === 'menu' || command === 'help') {
        const menu = `⚡ *PANEL PRINCIPAL - CocoBot* ⚡\n` +
            `────────────────────────\n` +
            `👤 *Creado por:* Alencito/Gabo\n` +
            `🚀 *Estado:* Online 24/7 \n` +
            `────────────────────────\n\n` +
            `🎮 *¡ÚNETE A NUESTRA COMUNIDAD!* 🎮\n` +
            `👉 *Discord Oficial:* https://discord.gg/mDQfz3UKbG\n\n` +
            `────────────────────────\n\n` +
            `📌 *GUÍA DE COMANDOS*\n\n` +
            `🤖 *IA y Utilidades:*\n` +
            `  *#ia [texto]* - Habla con la inteligencia artificial\n` +
            `  *#voz [texto]* - Convierte texto a nota de voz\n` +
            `  *#crypto [moneda]* - Precios en tiempo real\n` +
            `  *#partidos / #futbol [país]* - ⚽ Marcadores en vivo\n` +
            `  *#chistes / #chistenegro* - Humor aleatorio\n` +
            `  *#imagen [tema]* - Busca una foto aleatoria\n\n` +
            `🎭 *Reacciones y Rol:*\n` +
            `  _Úsalos solos o mencionando a alguien._\n` +
            `  ❤️ *Cariño:* #hug, #kiss, #pat, #cuddle, #love\n` +
            `  😡 *Agresivos:* #slap, #punch, #kill, #bite, #step\n` +
            `  😢 *Emociones:* #cry, #sad, #happy, #angry, #shy\n` +
            `  🤪 *Acciones:* #dance, #eat, #sleep, #gaming, #bath\n\n` +
            `🔞 *NSFW (Si el admin lo activa):*\n` +
            `  *#r34 [tag]* - Buscar imágenes (Ej: #r34 cat_girl)\n` +
            `  *#trivia18* - Preguntas picantes\n\n` +
            `👤 *Perfil y Redes:*\n` +
            `  *#perfil [@us]* - Muestra tu tarjeta con foto\n` +
            `  *#edad / #genero / #frase* - Edita tu tarjeta\n` +
            `  *#facebook, #instagram* - Añade tus redes\n` +
            `  *#still [texto/ver/borrar]* - Banco de notas\n\n` +
            `💍 *Social y Parejas:*\n` +
            `  *#casarse [@us] / #aceptar* - Matrimonio\n` +
            `  *#divorcio [@us] [tipo]* - normal, juicio o encuesta\n` +
            `  *#cumples / #cumple DD/MM* - Cumpleaños\n\n` +
            `💰 *Economía y Tienda:*\n` +
            `  *#bal* - Mira cuántos soles tienes\n` +
            `  *#work / #daily* - Trabaja (8h) o cobra diario\n` +
            `  *#crime* - Roba (15m, riesgo de multa)\n` +
            `  *#apostar / #ruleta / #slots* - Multiplica tus soles\n` +
            `  *#yapear [monto] [@us]* - Envía dinero\n` +
            `  *#topricos* - Ranking de millonarios\n` +
            `  *#tienda / #comprar [item]* - Gasta tus soles\n\n` +
            `⚖️ *Moderación y Justicia:*\n` +
            `  *#juicio [@us] [monto] [motivo]* - Demanda a alguien\n` +
            `  *#mutear [@us] [min] / #fianza* - Sistema de cárcel\n` +
            `  *#nsfw [on/off]* - Activar +18 en el grupo (Solo Admins)\n` +
            `  *#del* - Responde a un msj para borrarlo\n` +
            `  *#recordatorio [tiempo] [msj]* - Crea alarmas\n\n` +
            `🎨 *Multimedia:*\n` +
            `  *#s* - Convierte foto/video a sticker\n` +
            `  *#gif [texto]* - Busca un GIF y lo hace sticker\n` +
            `  *#toimg* - Convierte sticker a imagen`;

        await sock.sendMessage(from, { text: menu }, { quoted: m });
        return true;
    }

    if (command === 'gif') {
        const query = args.join(' ') || 'random';
        try {
            await sock.sendMessage(from, { text: `🔍 Buscando GIF para: *${query}*...` }, { quoted: m });
            const gifSticker = await obtenerGifAleatorio(query, 'https://media.giphy.com/media/l0HYXi9jy3N2b0fDG/giphy.gif');
            if (gifSticker) {
                await sock.sendMessage(from, { sticker: gifSticker }, { quoted: m });
            } else {
                await sock.sendMessage(from, { text: '❌ No se pudo obtener el GIF.' }, { quoted: m });
            }
        } catch {
            await sock.sendMessage(from, { text: '❌ Error al buscar el GIF.' }, { quoted: m });
        }
        return true;
    }

    if (command === 'cumple' || command === 'cumpleaños') {
        const fecha = args[0];
        if (!fecha || !fecha.includes('/')) {
            await sock.sendMessage(from, { text: '⚠️ Formato: *#cumple DD/MM* (ej: *#cumple 25/12*)' }, { quoted: m });
            return true;
        }

        const [dia, mes] = fecha.split('/').map(Number);
        if (!dia || !mes || dia < 1 || dia > 31 || mes < 1 || mes > 12) {
            await sock.sendMessage(from, { text: '⚠️ Fecha inválida. Usa formato DD/MM.' }, { quoted: m });
            return true;
        }

        await usersCollection.updateOne({ jid: sender }, { $set: { cumple: `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}` } }, { upsert: true });
        await sock.sendMessage(from, { text: `✅ ¡Tu cumpleaños ha sido registrado para el *${dia}/${mes}*! 🎂🎉` }, { quoted: m });
        return true;
    }

    if (command === 'cumples' || command === 'próximoscumples') {
        if (!from.endsWith('@g.us')) {
            await sock.sendMessage(from, { text: '⚠️ Este comando solo funciona en grupos.' }, { quoted: m });
            return true;
        }

        try {
            const usuarios = await usersCollection.find({ cumple: { $exists: true, $ne: null } }).toArray();
            if (usuarios.length === 0) {
                await sock.sendMessage(from, { text: '📭 Aún no hay cumpleaños registrados en el grupo.' }, { quoted: m });
                return true;
            }

            const cumpleanerosFiltrados = usuarios
                .map(u => ({
                    jid: u.jid,
                    cumple: u.cumple,
                    diasFaltantes: calcularDiasFaltantes(u.cumple)
                }))
                .sort((a, b) => a.diasFaltantes - b.diasFaltantes)
                .slice(0, 10);

            let txt = '🎂 *PRÓXIMOS CUMPLEAÑOS* 🎂\n\n';
            cumpleanerosFiltrados.forEach((u, idx) => {
                const diasFaltantes = u.diasFaltantes;
                if (diasFaltantes === 0) {
                    txt += `${idx + 1}. 🎉 *HOY* - @${u.jid.split('@')[0]} (${u.cumple})\n`;
                } else if (diasFaltantes === 1) {
                    txt += `${idx + 1}. 🔜 *MAÑANA* - @${u.jid.split('@')[0]} (${u.cumple})\n`;
                } else {
                    txt += `${idx + 1}. ⏳ En ${diasFaltantes} días - @${u.jid.split('@')[0]} (${u.cumple})\n`;
                }
            });

            const mentions = cumpleanerosFiltrados.map(u => u.jid);
            await sock.sendMessage(from, { text: txt, mentions }, { quoted: m });
        } catch (e) {
            console.error('Error en #cumples:', e);
            await sock.sendMessage(from, { text: '❌ Error al obtener los cumpleaños.' }, { quoted: m });
        }
        return true;
    }

    if (command === 'voz' || command === 'tts') {
        const textoVoz = args.join(' ');
        if (!textoVoz) {
            await sock.sendMessage(from, { text: '⚠️ Escribe el texto que deseas convertir a voz. Ej: *#voz Hola a todos*' }, { quoted: m });
            return true;
        }

        try {
            await sock.sendMessage(from, { text: '🎙️ Generando audio...' }, { quoted: m });
            const tts = new gtts(textoVoz, 'es');
            const tempFilePath = path.join(os.tmpdir(), `voice_${Date.now()}.mp3`);

            tts.save(tempFilePath, async function () {
                try {
                    const audioBuffer = fs.readFileSync(tempFilePath);
                    await sock.sendMessage(from, { audio: audioBuffer, mimetype: 'audio/mpeg', ptt: false }, { quoted: m });
                    fs.unlinkSync(tempFilePath);
                } catch (err) {
                    await sock.sendMessage(from, { text: '❌ No se pudo enviar el audio.' }, { quoted: m });
                }
            });
        } catch (err) {
            await sock.sendMessage(from, { text: '❌ Ocurrió un error al procesar el audio.' }, { quoted: m });
        }
        return true;
    }

    if (command === 'crypto' || command === 'precio' || command === 'cripto') {
        const moneda = args[0]?.toLowerCase() || 'bitcoin';
        try {
            await sock.sendMessage(from, { text: `🔍 Consultando precio de *${moneda}*...` }, { quoted: m });
            const headers = process.env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY } : {};
            const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(moneda)}&vs_currencies=usd,eur&include_24hr_change=true`;
            const response = await axios.get(url, { headers });

            state.apiUsageStats.coinGeckoRequests++;
            const data = response.data;

            if (!data[moneda]) {
                await sock.sendMessage(from, { text: `❌ No se encontró información para "${moneda}".` }, { quoted: m });
                return true;
            }

            const precioUsd = data[moneda].usd;
            const precioEur = data[moneda].eur;
            const cambio24h = data[moneda].usd_24h_change?.toFixed(2) || 0;
            const iconoCambio = cambio24h >= 0 ? '📈 🟢' : '📉 🔴';

            const textoCrypto = `🪙 *PRECIO DE MERCADO: ${moneda.toUpperCase()}* 🪙\n` +
                `────────────────────────\n` +
                `💵 *USD:* $${precioUsd.toLocaleString()}\n` +
                `💶 *EUR:* €${precioEur.toLocaleString()}\n` +
                `${iconoCambio} *Cambio 24h:* ${cambio24h}%\n` +
                `────────────────────────\n` +
                `🌐 *Fuente:* CoinGecko API`;
            await sock.sendMessage(from, { text: textoCrypto }, { quoted: m });
        } catch (err) {
            await sock.sendMessage(from, { text: '❌ Error al consultar la API de CoinGecko.' }, { quoted: m });
        }
        return true;
    }

    if (command === 's' || command === 'sticker') {
        try {
            const q = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const msgTipo = q ? Object.keys(q)[0] : messageType;

            if (msgTipo !== 'imageMessage' && msgTipo !== 'videoMessage') {
                await sock.sendMessage(from, { text: '⚠️ Responde a una imagen o video corto para convertirlo en sticker.' }, { quoted: m });
                return true;
            }

            await sock.sendMessage(from, { text: '🎨 Creando sticker...' }, { quoted: m });

            const targetMsg = q ? { message: q } : m;
            const buffer = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });

            const stickerBuffer = await sharp(buffer)
                .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .webp({ quality: 50 })
                .toBuffer();

            await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });
        } catch (err) {
            console.error('Error en #s:', err);
            await sock.sendMessage(from, { text: '❌ No se pudo convertir el archivo a sticker.' }, { quoted: m });
        }
        return true;
    }

    if (command === 'chistes' || command === 'chiste') {
        const chistesList = [
            "— Papá, papá, ¿qué se siente tener un hijo tan guapo, inteligente y perfecto?\n— No lo sé, hijo, pregúntale a tu abuelo.",
            "— ¡Camarero, camarero! Hay una mosca en mi sopa.\n— No se preocupe, caballero, nadará muy bien por ese precio.",
            "— ¿Por qué las focas miran siempre hacia arriba en los espectáculos?\n— Porque ahí están los focos.",
            "— Hola, ¿está Agustín?\n— No, estoy incomodísimo.",
            "— ¿Cuál es el colmo de un electricista?\n— No poder seguir corriente.",
            "— ¿Qué hace una abeja en el gimnasio?\n— ¡Zum-ba!"
        ];
        const chisteAleatorio = chistesList[Math.floor(Math.random() * chistesList.length)];
        await sock.sendMessage(from, { text: `😂 *Chiste:* \n\n${chisteAleatorio}` }, { quoted: m });
        return true;
    }

    if (command === 'chistenegro' || command === 'picante' || command === 'chistepicante') {
        const chistePicante = state.chistesPicantesList[Math.floor(Math.random() * state.chistesPicantesList.length)];
        await sock.sendMessage(from, { text: `🌶️ *Humor +18:* \n\n${chistePicante}` }, { quoted: m });
        return true;
    }

    if (command === 'vor' || command === 'verdadoreto') {
        const tipoElegido = args[0]?.toLowerCase();
        const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        let esVerdad;
        if (tipoElegido === 'verdad') esVerdad = true;
        else if (tipoElegido === 'reto') esVerdad = false;
        else esVerdad = Math.random() < 0.5;

        const item = esVerdad
            ? state.verdadesList[Math.floor(Math.random() * state.verdadesList.length)]
            : state.retosList[Math.floor(Math.random() * state.retosList.length)];

        const dirigidoA = target ? `@${target.split('@')[0]}` : `@${sender.split('@')[0]}`;
        const encabezado = esVerdad ? '🎯 *VERDAD*' : '🔥 *RETO*';

        await sock.sendMessage(from, {
            text: `${encabezado} para ${dirigidoA}:\n\n${item}\n\n_Usa #vor de nuevo para otra ronda._`,
            mentions: [target || sender]
        }, { quoted: m });
        return true;
    }

    if (command === 'r34' || command === 'rule34') {
        // Candado por Grupo
        if (from.endsWith('@g.us')) {
            const gData = await groupsCollection.findOne({ groupId: from });
            if (!gData?.nsfw) {
                await sock.sendMessage(from, { text: '❌ Los comandos +18 están desactivados en este grupo.\nUn administrador debe activar el modo usando: *#nsfw on*' }, { quoted: m });
                return true;
            }
        }

        const queryTag = args.join('_');
        if (!queryTag) {
            await sock.sendMessage(from, { text: '⚠️ Escribe qué etiqueta deseas buscar. Ej: *#r34 cat_girl*' }, { quoted: m });
            return true;
        }
        
        try {
            await sock.sendMessage(from, { text: '🔍 Buscando en la API...' }, { quoted: m });

            const credenciales = "api_key=1a359b6ec76881037aaabb7a01c58d3517e50be10fe3ec88296f8f8f3f8d568bb1791051e0c5b23f641b42e1a9d4b8a73f11a883c013049f69fd9e4d292bcc85&user_id=6781834";
            const urlApi = `https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&tags=${encodeURIComponent(queryTag)}&json=1&${credenciales}`;

            const respuesta = await axios.get(urlApi, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });

            const posts = respuesta.data;

            if (!posts || !Array.isArray(posts) || posts.length === 0) {
                await sock.sendMessage(from, { text: `❌ No se encontraron resultados para: "${queryTag}".` }, { quoted: m });
                return true;
            }

            const postsValidos = posts.filter(p => p.file_url || p.sample_url || p.image);
            if (postsValidos.length === 0) {
                await sock.sendMessage(from, { text: `❌ Los resultados encontrados no tienen imágenes disponibles.` }, { quoted: m });
                return true;
            }

            const postAleatorio = postsValidos[Math.floor(Math.random() * postsValidos.length)];
            const mediaUrl = postAleatorio.file_url || postAleatorio.sample_url || `https://img.rule34.xxx//images/${postAleatorio.directory}/${postAleatorio.image}`;

            const esVideo = mediaUrl.endsWith('.webm') || mediaUrl.endsWith('.mp4');

            if (esVideo) {
                await sock.sendMessage(from, { 
                    video: { url: mediaUrl }, 
                    caption: `🔞 *Resultado:* ${queryTag}` 
                }, { quoted: m });
            } else {
                await sock.sendMessage(from, { 
                    image: { url: mediaUrl }, 
                    caption: `🔞 *Resultado:* ${queryTag}` 
                }, { quoted: m });
            }

        } catch (err) {
            console.error('Error detallado en R34:', err.message);
            await sock.sendMessage(from, { text: '❌ Ocurrió un error al procesar la solicitud de la API.' }, { quoted: m });
        }
        return true;
    }

    if (command === 'trivia18') {
        const preguntaTrivia = state.trivia18List[Math.floor(Math.random() * state.trivia18List.length)];
        const letras = ['A', 'B', 'C', 'D'];
        let textoOpciones = '';
        preguntaTrivia.opciones.forEach((op, idx) => { textoOpciones += `${letras[idx]}) ${op}\n`; });

        state.triviaActiva.set(from, { correctaIndex: preguntaTrivia.correcta, letras, expira: Date.now() + 30000 });

        setTimeout(() => {
            const activa = state.triviaActiva.get(from);
            if (activa && activa.expira <= Date.now() + 1) state.triviaActiva.delete(from);
        }, 30000);

        await sock.sendMessage(from, {
            text: `🧠 *TRIVIA +18* 🧠\n\n${preguntaTrivia.pregunta}\n\n${textoOpciones}\n⏱️ Tienes 30s. Responde con *#trivia [letra]*`
        }, { quoted: m });
        return true;
    }

    if (command === 'trivia') {
        const activa = state.triviaActiva.get(from);
        if (!activa) {
            await sock.sendMessage(from, { text: '⚠️ No hay trivia activa. Inicia una con *#trivia18*.' }, { quoted: m });
            return true;
        }
        if (Date.now() > activa.expira) {
            state.triviaActiva.delete(from);
            await sock.sendMessage(from, { text: '⏱️ El tiempo para responder ya se acabó.' }, { quoted: m });
            return true;
        }
        const respuestaLetra = args[0]?.toUpperCase();
        const idxRespuesta = activa.letras.indexOf(respuestaLetra);
        if (idxRespuesta === -1) {
            await sock.sendMessage(from, { text: '⚠️ Responde con una letra válida. Ej: *#trivia A*' }, { quoted: m });
            return true;
        }

        state.triviaActiva.delete(from);
        if (idxRespuesta === activa.correctaIndex) {
            const premio = 150;
            await usersCollection.updateOne({ jid: sender }, { $inc: { soles: premio } }, { upsert: true });
            await sock.sendMessage(from, { text: `✅ ¡Correcto! Ganaste *🪙 ${premio} soles*.` }, { quoted: m });
        } else {
            await sock.sendMessage(from, { text: `❌ Incorrecto. La respuesta correcta era *${activa.letras[activa.correctaIndex]}*.` }, { quoted: m });
        }
        return true;
    }

    if (command === 'toimg' || command === 'foto') {
        try {
            const q = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const msgTipo = q ? Object.keys(q)[0] : messageType;

            if (msgTipo !== 'stickerMessage') {
                await sock.sendMessage(from, { text: '⚠️ Responde a un sticker para convertirlo en imagen.' }, { quoted: m });
                return true;
            }

            await sock.sendMessage(from, { text: '🔄 Convirtiendo a imagen...' }, { quoted: m });

            const targetMsg = q ? { message: q } : m;
            const buffer = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });

            const outputBuffer = await sharp(buffer).jpeg().toBuffer();

            await sock.sendMessage(from, { image: outputBuffer, caption: '🖼️ Aquí tienes tu imagen.' }, { quoted: m });
        } catch (err) {
            console.error('Error en #toimg:', err);
            await sock.sendMessage(from, { text: '❌ No se pudo convertir el sticker a imagen.' }, { quoted: m });
        }
        return true;
    }

    if (command === 'imagen' || command === 'imgsearch') {
        const query = args.join(' ');
        if (!query) {
            await sock.sendMessage(from, { text: '⚠️ Escribe qué imagen buscas. Ej: *#imagen paisajes*' }, { quoted: m });
            return true;
        }
        try {
            await sock.sendMessage(from, { text: '🔍 Buscando imagen...' }, { quoted: m });
            const imageUrl = `https://picsum.photos/800/600?random=${Math.random()}`;
            await sock.sendMessage(from, { image: { url: imageUrl }, caption: `🖼️ Resultado para: *${query}*` }, { quoted: m });
        } catch {
            await sock.sendMessage(from, { text: '❌ No se pudo obtener la imagen.' }, { quoted: m });
        }
        return true;
    }

    if (command === 'still') {
        const subAction = args[0]?.toLowerCase();
        const textoBanco = args.join(' ');

        if (!subAction || subAction === 'ver' || subAction === 'lista') {
            const notas = await bankCollection.find({ userJid: sender }).toArray();
            if (notas.length === 0) {
                await sock.sendMessage(from, { text: '📭 Tu banco personal `#still` está vacío.' }, { quoted: m });
                return true;
            }
            let txt = '📦 *TU BANCO PERSONAL (#STILL)* 📦\n\n';
            notas.forEach((n, idx) => { txt += `${idx + 1}. ID: \`${n._id}\`\n   📝 "${n.content}"\n\n`; });
            txt += `💡 Usa *#still borrar [ID]* para eliminar una nota.`;
            await sock.sendMessage(from, { text: txt }, { quoted: m });
            return true;
        }

        if (subAction === 'borrar' || subAction === 'del') {
            const { ObjectId } = require('mongodb');
            const idNota = args[1];
            if (!idNota) {
                await sock.sendMessage(from, { text: '⚠️ Especifica el ID de la nota.' }, { quoted: m });
                return true;
            }
            try {
                const res = await bankCollection.deleteOne({ _id: new ObjectId(idNota), userJid: sender });
                if (res.deletedCount > 0) await sock.sendMessage(from, { text: '✅ Nota eliminada.' }, { quoted: m });
                else await sock.sendMessage(from, { text: '❌ No se encontró esa nota.' }, { quoted: m });
            } catch { 
                await sock.sendMessage(from, { text: '⚠️ ID inválido.' }, { quoted: m }); 
            }
            return true;
        }
        await bankCollection.insertOne({ userJid: sender, content: textoBanco, createdAt: new Date() });
        await sock.sendMessage(from, { text: `✅ ¡Guardado con éxito!\n📌 "${textoBanco}"` }, { quoted: m });
        return true;
    }

    if (command === 'edad') {
        const edadNum = parseInt(args[0]);
        if (!edadNum || isNaN(edadNum)) {
            await sock.sendMessage(from, { text: '⚠️ Indica una edad válida.' }, { quoted: m });
            return true;
        }
        await usersCollection.updateOne({ jid: sender }, { $set: { edad: edadNum } }, { upsert: true });
        await sock.sendMessage(from, { text: `✅ ¡Edad actualizada a *${edadNum} años*!` }, { quoted: m });
        return true;
    }

    if (command === 'frase' || command === 'bio') {
        const fraseText = args.join(' ');
        if (!fraseText) {
            await sock.sendMessage(from, { text: '⚠️ Escribe tu frase personal.' }, { quoted: m });
            return true;
        }
        await usersCollection.updateOne({ jid: sender }, { $set: { frase: fraseText } }, { upsert: true });
        await sock.sendMessage(from, { text: `✅ Frase de perfil actualizada correctamente.` }, { quoted: m });
        return true;
    }

    if (['facebook', 'instagram', 'discord', 'spotify', 'x'].includes(command)) {
        const redLink = args.join(' ');
        if (!redLink) {
            await sock.sendMessage(from, { text: `⚠️ Escribe tu enlace de ${command}.` }, { quoted: m });
            return true;
        }
        await usersCollection.updateOne({ jid: sender }, { $set: { [`redes.${command}`]: redLink } }, { upsert: true });
        await sock.sendMessage(from, { text: `✅ Enlace de *${command.toUpperCase()}* guardado con éxito.` }, { quoted: m });
        return true;
    }

    if (command === 'setsticker' || command === 'identidad') {
        const q = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
        if (messageType !== 'stickerMessage' && !q?.stickerMessage) {
            await sock.sendMessage(from, { text: '⚠️ Responde a un sticker.' }, { quoted: m });
            return true;
        }
        try {
            const targetMsg = q ? { message: q } : m;
            const stickerBuf = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
            await usersCollection.updateOne({ jid: sender }, { $set: { stickerBase64: stickerBuf.toString('base64') } }, { upsert: true });
            await sock.sendMessage(from, { text: '✅ ¡Sticker guardado con éxito!' }, { quoted: m });
        } catch { 
            await sock.sendMessage(from, { text: '❌ Error al guardar el sticker.' }, { quoted: m }); 
        }
        return true;
    }

    if (command === 'perfil' || command === 'verperfil') {
        const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.message.extendedTextMessage?.contextInfo?.participant || sender;
        const uData = await usersCollection.findOne({ jid: target }) || {};
        const statsData = from.endsWith('@g.us') ? (await groupStatsCollection.findOne({ jid: target, groupId: from }) || {}) : {};
        
        let parejas = uData.pareja || [];
        if (typeof parejas === 'string') parejas = [parejas];
        let nombrePareja = parejas.length > 0 ? parejas.map(p => `@${p.split('@')[0]} 💍`).join(', ') : 'Soltero/a 💔';

        const redes = uData.redes || {};
        let redesTxt = '';
        if (redes.facebook) redesTxt += `📘 *Facebook:* ${redes.facebook}\n`;
        if (redes.instagram) redesTxt += `📸 *Instagram:* ${redes.instagram}\n`;
        if (redes.discord) redesTxt += `🎮 *Discord:* ${redes.discord}\n`;
        if (redes.spotify) redesTxt += `🎧 *Spotify:* ${redes.spotify}\n`;
        if (redes.x) redesTxt += `✖️ *X:* ${redes.x}\n`;

        const perfilTxt = `👤 *PERFIL DE USUARIO* 👤\n` +
            `────────────────────────\n` +
            `📌 *Usuario:* @${target.split('@')[0]}\n` +
            `🎂 *Edad:* ${uData.edad ? uData.edad + ' años' : 'No especificada'}\n` +
            `⚧️ *Género:* ${uData.genero || 'No especificado'}\n` +
            `💬 *Frase:* "${uData.frase || 'Sin frase'}"\n` +
            `💍 *Estado Civil:* ${nombrePareja}\n` +
            `🎂 *Cumpleaños:* ${uData.cumple || 'No registrado'}\n` +
            `🪙 *Soles:* ${uData.soles || 0}\n` +
            `📊 *Mensajes:* ${statsData.messageCount || 0}\n` +
            (redesTxt ? `\n🌐 *REDES SOCIALES:*\n${redesTxt}` : '');

        // INTENTO DE OBTENER LA FOTO DE PERFIL DE WHATSAPP
        let pfpUrl;
        try {
            pfpUrl = await sock.profilePictureUrl(target, 'image');
        } catch (err) {
            pfpUrl = null; // Si no tiene foto o la tiene oculta por privacidad
        }

        const mentions = [target, ...parejas].filter(Boolean);

        // Si encontramos la foto, enviamos la imagen con el texto de pie de foto
        if (pfpUrl) {
            await sock.sendMessage(from, { image: { url: pfpUrl }, caption: perfilTxt, mentions: mentions }, { quoted: m });
        } else {
            // Si no hay foto, enviamos solo el texto clásico
            await sock.sendMessage(from, { text: perfilTxt, mentions: mentions }, { quoted: m });
        }

        if (uData.stickerBase64) {
            try { await sock.sendMessage(from, { sticker: Buffer.from(uData.stickerBase64, 'base64') }); } catch {}
        }
        return true;
    }

    if (command === 'recordatorio' || command === 'rec' || command === 'recordatorio-grupo' || command === 'recg') {
        const esGrupal = command.includes('grupo') || command === 'recg';
        const destinoJid = esGrupal ? from : sender;
        if (esGrupal && !from.endsWith('@g.us')) {
            await sock.sendMessage(from, { text: '⚠️ Comando de grupo.' }, { quoted: m });
            return true;
        }
        const arg1 = args[0];
        const arg2 = args[1];

        if (!arg1 || !arg2) {
            await sock.sendMessage(from, { text: '⚠️ Formato incorrecto. Ej: `#rec 10m Mensaje` o `#recg 10/09 15:30 Mensaje`' }, { quoted: m });
            return true;
        }

        let fechaEjecucion = null;
        let tiempoTextoMostrar = '';
        let mensajeRec = '';

        if (arg1.includes('/')) {
            const [dia, mes] = arg1.split('/').map(Number);
            const horaStr = arg2;
            if (!horaStr || !horaStr.includes(':')) {
                await sock.sendMessage(from, { text: '⚠️ Formato de hora inválido.' }, { quoted: m });
                return true;
            }
            const [hora, minuto] = horaStr.split(':').map(Number);
            const hoyPeru = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Lima" }));
            fechaEjecucion = new Date(hoyPeru.getFullYear(), mes - 1, dia, hora, minuto, 0);
            if (fechaEjecucion < hoyPeru) fechaEjecucion.setFullYear(hoyPeru.getFullYear() + 1);
            tiempoTextoMostrar = `el ${arg1} a las ${arg2}`;
            mensajeRec = args.slice(2).join(' ');
        } else {
            const match = arg1.match(/^(\d+)([smh])$/);
            if (!match) {
                await sock.sendMessage(from, { text: '⚠️ Unidad de tiempo inválida.' }, { quoted: m });
                return true;
            }
            const cantidad = parseInt(match[1]);
            const unidad = match[2];
            let multiplicador = 1000;
            if (unidad === 'm') multiplicador = 60 * 1000;
            if (unidad === 'h') multiplicador = 60 * 60 * 1000;
            fechaEjecucion = new Date(Date.now() + cantidad * multiplicador);
            tiempoTextoMostrar = arg1;
            mensajeRec = args.slice(1).join(' ');
        }

        if (!mensajeRec) {
            await sock.sendMessage(from, { text: '⚠️ Faltó el mensaje.' }, { quoted: m });
            return true;
        }

        const resultado = await remindersCollection.insertOne({ 
            userJid: sender, targetJid: destinoJid, isGroup: esGrupal, message: mensajeRec, executeAt: fechaEjecucion, createdAt: new Date() 
        });

        await sock.sendMessage(from, { text: `✅ ¡Recordatorio programado! Te avisaré ${tiempoTextoMostrar} (ID: \`${resultado.insertedId}\`).` }, { quoted: m });
        return true;
    }

    if (command === 'consumo' || command === 'stats' || command === 'recursos') {
        if (!esOwner(sender)) return true;
        const memUsadaByBot = process.memoryUsage().rss / (1024 * 1024);
        const statsText = `📊 *MONITOREO DE RECURSOS - COCOBOT* 📊\n` +
            `────────────────────────\n` +
            `🖥️ *Hosting:* Render (Cloud Free Tier)\n` +
            `🧠 *RAM Usada (Bot Node.js):* ${memUsadaByBot.toFixed(2)} MB\n` +
            `⚡ *CPU Cores:* ${os.cpus().length} Núcleos\n` +
            `⏱️ *Uptime:* ${(process.uptime() / 60).toFixed(1)} minutos\n`;
        await sock.sendMessage(from, { text: statsText }, { quoted: m });
        return true;
    }

    if (command === 'tokens' || command === 'apistats' || command === 'usoapis') {
        if (!esOwner(sender)) return true;
        const reporteTokens = `📊 *REPORTE DE CONSUMO DE APIS* 📊\n` +
            `🤖 *Gemini AI:* Peticiones: \`${state.apiUsageStats.geminiRequests}\` | Tokens Totales: \`${state.apiUsageStats.totalTokensUsed}\`\n` +
            `🪙 *CoinGecko:* Peticiones: \`${state.apiUsageStats.coinGeckoRequests}\``;
        await sock.sendMessage(from, { text: reporteTokens }, { quoted: m });
        return true;
    }

    if (command === 'partidos' || command === 'futbol') {
        const paisBuscado = args.join(' ').toLowerCase();

        // 1. BLOQUEO: Obligamos al usuario a poner un país
        if (!paisBuscado) {
            await sock.sendMessage(from, { 
                text: '⚠️ Debes especificar de qué país o región quieres ver los partidos en vivo.\n\nEjemplo: *#futbol peru*, *#futbol españa*, *#futbol europa*, *#futbol brasil*' 
            }, { quoted: m });
            return true;
        }

        try {
            await sock.sendMessage(from, { text: `⚽ Buscando partidos en vivo para: *${paisBuscado.toUpperCase()}*...` }, { quoted: m });

            const apiKey = process.env.API_FOOTBALL_KEY;
            if (!apiKey) {
                await sock.sendMessage(from, { text: '⚠️ La API Key de fútbol no está configurada.' }, { quoted: m });
                return true;
            }

            // Diccionario traductor (Español -> Inglés API)
            const traducciones = {
                'perú': 'Peru', 'peru': 'Peru',
                'españa': 'Spain', 'espana': 'Spain',
                'inglaterra': 'England',
                'alemania': 'Germany',
                'italia': 'Italy',
                'francia': 'France',
                'argentina': 'Argentina',
                'brasil': 'Brazil',
                'mexico': 'Mexico', 'méxico': 'Mexico',
                'colombia': 'Colombia',
                'chile': 'Chile',
                'uruguay': 'Uruguay',
                'ecuador': 'Ecuador',
                'europa': 'Europe', 
                'mundo': 'World',   
                'sudamerica': 'South-America', 'sudamérica': 'South-America'
            };

            const response = await axios.get('https://v3.football.api-sports.io/fixtures?live=all', {
                headers: { 'x-apisports-key': apiKey }
            });

            const todosLosPartidos = response.data.response;

            if (!todosLosPartidos || todosLosPartidos.length === 0) {
                await sock.sendMessage(from, { text: 'ℹ️ No hay ningún partido jugándose en el mundo en este preciso momento.' }, { quoted: m });
                return true;
            }

            const paisApi = traducciones[paisBuscado] || paisBuscado; 
            
            // 2. FILTRO ESTRICTO: Solo el país exacto
            const partidosFiltro = todosLosPartidos.filter(p => p.league.country.toLowerCase() === paisApi.toLowerCase());
            
            if (partidosFiltro.length === 0) {
                await sock.sendMessage(from, { text: `ℹ️ No se encontraron partidos en vivo para: *${paisBuscado.toUpperCase()}* ahora mismo.` }, { quoted: m });
                return true;
            }

            const partidosMostrados = partidosFiltro.slice(0, 15);
            let textoPartidos = `🔴 *PARTIDOS EN VIVO: ${paisApi.toUpperCase()}* 🔴\n\n`;

            partidosMostrados.forEach(p => {
                const homeTeam = p.teams.home.name;
                const awayTeam = p.teams.away.name;
                const homeScore = p.goals.home ?? 0;
                const awayScore = p.goals.away ?? 0;
                const minuto = p.fixture.status.elapsed ? `${p.fixture.status.elapsed}'` : p.fixture.status.short;
                const liga = p.league.name;

                textoPartidos += `🏆 *${liga}*\n`;
                textoPartidos += `⏱️ ${minuto} | 🛡️ ${homeTeam} *${homeScore} - ${awayScore}* ${awayTeam}\n`;
                textoPartidos += `────────────────\n`;
            });

            if (partidosFiltro.length > 15) {
                textoPartidos += `\n_...y ${partidosFiltro.length - 15} partidos más._`;
            }

            await sock.sendMessage(from, { text: textoPartidos }, { quoted: m });
            return true;

        } catch (err) {
            console.error('Error en API-Football:', err.message);
            await sock.sendMessage(from, { text: '❌ Ocurrió un error al consultar los marcadores. Verifica tu API Key.' }, { quoted: m });
            return true;
        }
    }

    if (command === 'topmsg' || command === 'masactivos') {
        if (!from.endsWith('@g.us')) {
            await sock.sendMessage(from, { text: '⚠️ Solo grupos.' }, { quoted: m });
            return true;
        }
        const topUsers = await groupStatsCollection.find({ groupId: from, messageCount: { $exists: true } }).sort({ messageCount: -1 }).limit(5).toArray();
        if (topUsers.length === 0) {
            await sock.sendMessage(from, { text: '📊 Aún no hay registros.' }, { quoted: m });
            return true;
        }
        let txt = '🏆 *TOP 5 - USUARIOS QUE MÁS ESCRIBEN* 🏆\n\n';
        topUsers.forEach((u, i) => { txt += `${i + 1}. @${u.jid.split('@')[0]} ➡️ *${u.messageCount || 0} mensajes*\n`; });
        await sock.sendMessage(from, { text: txt, mentions: topUsers.map(u => u.jid) }, { quoted: m });
        return true;
    }

    if (command === 'lowmsg' || command === 'menosactivos') {
        if (!from.endsWith('@g.us')) {
            await sock.sendMessage(from, { text: '⚠️ Solo grupos.' }, { quoted: m });
            return true;
        }
        const lowUsers = await groupStatsCollection.find({ groupId: from, messageCount: { $exists: true } }).sort({ messageCount: 1 }).limit(5).toArray();
        if (lowUsers.length === 0) {
            await sock.sendMessage(from, { text: '📊 Aún no hay registros.' }, { quoted: m });
            return true;
        }
        let txt = '💤 *TOP 5 - USUARIOS QUE MENOS ESCRIBEN* 💤\n\n';
        lowUsers.forEach((u, i) => { txt += `${i + 1}. @${u.jid.split('@')[0]} ➡️ *${u.messageCount || 0} mensajes*\n`; });
        await sock.sendMessage(from, { text: txt, mentions: lowUsers.map(u => u.jid) }, { quoted: m });
        return true;
    }

    if (command === 'genero') {
        const generoTexto = args.join(' ');
        if (!generoTexto) {
            await sock.sendMessage(from, { text: '⚠️ Escribe tu género.' }, { quoted: m });
            return true;
        }
        await usersCollection.updateOne({ jid: sender }, { $set: { genero: generoTexto } }, { upsert: true });
        await sock.sendMessage(from, { text: `✅ Género actualizado a: *${generoTexto}*.` }, { quoted: m });
        return true;
    }

    if (command === 'casarse' || command === 'matrimonio') {
        const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!target || target === sender) {
            await sock.sendMessage(from, { text: '⚠️ Menciona a otra persona para casarte.' }, { quoted: m });
            return true;
        }
        
        const uData = await usersCollection.findOne({ jid: sender });
        const parejas = Array.isArray(uData?.pareja) ? uData.pareja : (uData?.pareja ? [uData.pareja] : []);
        
        if (parejas.includes(target)) {
            await sock.sendMessage(from, { text: '⚠️ Ya estás casado/a con esa persona.' }, { quoted: m });
            return true;
        }

        state.propuestasMatrimonio.set(target, sender);
        await sock.sendMessage(from, { text: `💍 ¡@${sender.split('@')[0]} le propuso matrimonio a @${target.split('@')[0]}!\nEscribe *#aceptar* para confirmar.`, mentions: [sender, target] }, { quoted: m });
        return true;
    }

    if (command === 'aceptar') {
        const proponte = state.propuestasMatrimonio.get(sender);
        if (!proponte) {
            await sock.sendMessage(from, { text: '⚠️ No tienes propuestas pendientes.' }, { quoted: m });
            return true;
        }
        
        await usersCollection.updateOne({ jid: sender }, { $addToSet: { pareja: proponte } }, { upsert: true });
        await usersCollection.updateOne({ jid: proponte }, { $addToSet: { pareja: sender } }, { upsert: true });
        
        state.propuestasMatrimonio.delete(sender);
        await sock.sendMessage(from, { text: `🎉 ¡VIVA LOS NOVIOS! @${proponte.split('@')[0]} y @${sender.split('@')[0]} están casados. 💍`, mentions: [sender, proponte] }, { quoted: m });
        return true;
    }

    const accionesMap = {
        angry: { query: 'anime angry mad', action: 'está enojado/a 💢' },
        enojado: { query: 'anime angry mad', action: 'está enojado/a 💢' },
        bath: { query: 'anime bath chill', action: 'se fue a bañar 🛁' },
        bite: { query: 'anime bite', action: 'le dio un mordisco a' },
        bleh: { query: 'anime bleh tongue', action: 'saca la lengua 😛' },
        blush: { query: 'anime blush shy', action: 'se ha sonrojado 😳' },
        bored: { query: 'anime bored yawn', action: 'está aburrido/a 🥱' },
        aburrido: { query: 'anime bored yawn', action: 'está aburrido/a 🥱' },
        call: { query: 'anime phone call', action: 'está llamando a' },
        clap: { query: 'anime clap applause', action: 'está aplaudiendo 👏' },
        aplaudir: { query: 'anime clap applause', action: 'está aplaudiendo 👏' },
        coffee: { query: 'anime drinking coffee', action: 'está tomando un café ☕' },
        cafe: { query: 'anime drinking coffee', action: 'está tomando un café ☕' },
        cold: { query: 'anime cold shivering', action: 'tiene mucho frío 🥶' },
        cook: { query: 'anime cooking delicious', action: 'está cocinando algo delicioso 🍳' },
        cry: { query: 'anime crying tears', action: 'se puso a llorar 😭' },
        cuddle: { query: 'anime cuddle cute', action: 'se está acurrucando con' },
        dance: { query: 'anime dancing happy', action: 'se sacó los pasitos prohibidos 💃' },
        dramatic: { query: 'anime dramatic shock', action: 'está haciendo un drama total 🎭' },
        drama: { query: 'anime dramatic shock', action: 'está haciendo un drama total 🎭' },
        draw: { query: 'anime drawing art', action: 'se puso a dibujar 🎨' },
        drunk: { query: 'anime drunk dizzy', action: 'anda medio borracho/a 🍻' },
        eat: { query: 'anime eating food', action: 'está comiendo algo delicioso 🍜' },
        comer: { query: 'anime eating food', action: 'está comiendo algo delicioso 🍜' },
        facepalm: { query: 'anime facepalm', action: 'se dio una palmada en la cara 🤦' },
        gaming: { query: 'anime gaming gamer', action: 'se puso a jugar videojuegos 🎮' },
        greet: { query: 'anime waving hello hi', action: 'saluda alegremente a' },
        hi: { query: 'anime waving hello hi', action: 'saluda alegremente a' },
        happy: { query: 'anime happy jump joy', action: 'salta de felicidad 🎉' },
        feliz: { query: 'anime happy jump joy', action: 'salta de felicidad 🎉' },
        heat: { query: 'anime hot sweat summer', action: 'se está muriendo de calor 🥵' },
        hug: { query: 'anime hug warm', action: 'le dio un abrazo cálido a 🫂' },
        impregnate: { query: 'anime shock stare', action: 'dejó pensando seriamente a' },
        preg: { query: 'anime shock stare', action: 'dejó pensando seriamente a' },
        preñar: { query: 'anime shock stare', action: 'dejó pensando seriamente a' },
        jump: { query: 'anime jumping excited', action: 'está saltando de la emoción 🦘' },
        kill: { query: 'anime punch fight weapon', action: 'saca su arma y ataca a 🔪' },
        kiss: { query: 'anime kiss love', action: 'le dio un tierno beso a 💋' },
        muak: { query: 'anime kiss love', action: 'le dio un tierno beso a 💋' },
        kisscheek: { query: 'anime cheek kiss cute', action: 'le dio un beso en la mejilla a 😊' },
        beso: { query: 'anime cheek kiss cute', action: 'le dio un beso en la mejilla a 😊' },
        laugh: { query: 'anime laughing lol', action: 'se está reír y reír de' },
        lewd: { query: 'anime smug cheeky', action: 'tiene una mirada bastante traviesa 😏' },
        lick: { query: 'anime lick taste', action: 'le dio una lamida a 👅' },
        love: { query: 'anime in love hearts', action: 'se siente completamente enamorado/a ❤️' },
        amor: { query: 'anime in love hearts', action: 'se siente completamente enamorado/a ❤️' },
        nope: { query: 'anime nope deny headshake', action: 'se niega rotundamente a hacerlo 🙅' },
        pat: { query: 'anime headpat cute', action: 'le acaricia la cabeza suavemente a 🤲' },
        poke: { query: 'anime poke cheek', action: 'le está picando las costillas a 👉' },
        pout: { query: 'anime pout angry cute', action: 'está haciendo un puchero 😒' },
        psycho: { query: 'anime creepy yandere smile', action: 'tiene una sonrisa bastante psicópata 👁️👄👁️' },
        punch: { query: 'anime punch hit', action: 'le dio un fuerte puñetazo a 👊' },
        push: { query: 'anime push away', action: 'empujó lejos a' },
        run: { query: 'anime running fast escape', action: 'salió corriendo a toda velocidad 🏃' },
        sad: { query: 'anime sad depression', action: 'expresa mucha tristeza 🥀' },
        triste: { query: 'anime sad depression', action: 'expresa mucha tristeza 🥀' },
        scared: { query: 'anime scared shock fear', action: 'está temblando de miedo 😱' },
        scream: { query: 'anime screaming loud', action: 'soltó un grito al aire 🗣️' },
        seduce: { query: 'anime seduce wink charm', action: 'intentó seducir a' },
        shy: { query: 'anime shy nervous', action: 'siente muchísima timidez 🙈' },
        timido: { query: 'anime shy nervous', action: 'siente muchísima timidez 🙈' },
        sing: { query: 'anime singing microphone', action: 'se puso a cantar a pulmón herido 🎤' },
        slap: { query: 'anime slap angry', action: 'le dio una tremenda bofetada a 👋' },
        sleep: { query: 'anime sleeping tired zzz', action: 'se tumbó a dormir profundamente 💤' },
        smoke: { query: 'anime smoking chill', action: 'está fumando pensativamente 🚬' },
        spit: { query: 'anime spit disgust', action: 'escupió asqueado/a 💦' },
        escupir: { query: 'anime disgust spit', action: 'escupió asqueado/a 💦' },
        step: { query: 'anime step down', action: 'le pisó el pie a' },
        pisar: { query: 'anime step down', action: 'le pisó el pie a' },
        think: { query: 'anime thinking smart', action: 'se quedó pensando profundamente 🤔' },
        tickle: { query: 'anime tickle laugh', action: 'le está haciendo cosquillas sin parar a 🤲' },
        walk: { query: 'anime walking stroll', action: 'se fue a dar un paseo caminando 🚶' }
    };

    if (accionesMap[command]) {
        const config = accionesMap[command];
        const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        let caption;
        let mentions = [sender];

        if (target) {
            caption = `@${sender.split('@')[0]} ${config.action} @${target.split('@')[0]}! ✨`;
            mentions.push(target);
        } else {
            caption = `@${sender.split('@')[0]} ${config.action} ✨`;
        }

        const backupDefault = 'https://media.giphy.com/media/l1J9EdzfOSgfyfeLm/giphy.gif';
        const sticker = await obtenerGifAleatorio(config.query, backupDefault);

        if (sticker) {
            await sock.sendMessage(from, { text: caption, mentions }, { quoted: m });
            await sock.sendMessage(from, { sticker });
            return true;
        }
    }

    return false;
}

module.exports = {
    useMongoDBAuthState,
    obtenerGifAleatorio,
    calcularDiasFaltantes,
    esOwner,
    handleCommand
};