async function handleCommand(ctx) {
    try {
        const { sock, m, from, sender, args, command, messageType, usersCollection, groupStatsCollection } = ctx;
        
        const downloadMediaMessage = ctx.deps?.downloadMediaMessage;
        const pino = ctx.deps?.pino;

        if (command === 'edad') {
            const edadNum = parseInt(args[0]);
            if (!edadNum || isNaN(edadNum)) {
                await sock.sendMessage(from, { text: '⚠️ Indica una edad válida. Ej: *#edad 20*' }, { quoted: m });
                return true;
            }
            if (usersCollection) await usersCollection.updateOne({ jid: sender }, { $set: { edad: edadNum } }, { upsert: true });
            await sock.sendMessage(from, { text: `✅ ¡Edad actualizada a *${edadNum} años*!` }, { quoted: m });
            return true;
        }

        if (command === 'genero') {
            const generoTexto = args.join(' ');
            if (!generoTexto) {
                await sock.sendMessage(from, { text: '⚠️ Escribe tu género.' }, { quoted: m });
                return true;
            }
            if (usersCollection) await usersCollection.updateOne({ jid: sender }, { $set: { genero: generoTexto } }, { upsert: true });
            await sock.sendMessage(from, { text: `✅ Género actualizado a: *${generoTexto}*.` }, { quoted: m });
            return true;
        }

        if (command === 'frase' || command === 'bio') {
            const fraseText = args.join(' ');
            if (!fraseText) {
                await sock.sendMessage(from, { text: '⚠️ Escribe tu frase personal.' }, { quoted: m });
                return true;
            }
            if (usersCollection) await usersCollection.updateOne({ jid: sender }, { $set: { frase: fraseText } }, { upsert: true });
            await sock.sendMessage(from, { text: `✅ Frase de perfil actualizada correctamente.` }, { quoted: m });
            return true;
        }

        if (['facebook', 'instagram', 'discord', 'spotify', 'x'].includes(command)) {
            const redLink = args.join(' ');
            if (!redLink) {
                await sock.sendMessage(from, { text: `⚠️ Escribe tu enlace de ${command}.` }, { quoted: m });
                return true;
            }
            if (usersCollection) await usersCollection.updateOne({ jid: sender }, { $set: { [`redes.${command}`]: redLink } }, { upsert: true });
            await sock.sendMessage(from, { text: `✅ Enlace de *${command.toUpperCase()}* guardado con éxito.` }, { quoted: m });
            return true;
        }

        if (command === 'setsticker' || command === 'identidad') {
            const q = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (messageType !== 'stickerMessage' && !q?.stickerMessage) {
                await sock.sendMessage(from, { text: '⚠️ Responde a un sticker para guardarlo como tu identidad.' }, { quoted: m });
                return true;
            }
            if (!downloadMediaMessage || !pino) {
                await sock.sendMessage(from, { text: '❌ Error interno: faltan dependencias para leer el sticker.' }, { quoted: m });
                return true;
            }
            try {
                const targetMsg = q ? { message: q } : m;
                const stickerBuf = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                if (usersCollection) await usersCollection.updateOne({ jid: sender }, { $set: { stickerBase64: stickerBuf.toString('base64') } }, { upsert: true });
                await sock.sendMessage(from, { text: '✅ ¡Sticker guardado con éxito!' }, { quoted: m });
            } catch (err) { 
                await sock.sendMessage(from, { text: '❌ Error al guardar el sticker.' }, { quoted: m }); 
            }
            return true;
        }

        if (command === 'perfil' || command === 'verperfil') {
            const argTexto = args.join(' ').toLowerCase();
            const mentionedJid = m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            let target = mentionedJid || sender;
            
            // 🛑 EL NÚMERO FIJO DEL BOT
            const numeroFijoBot = "51983305307"; 
            
            const targetNum = target ? target.replace(/[^0-9]/g, '') : '';
            const botFullId = sock?.user?.id || sock?.authState?.creds?.me?.id || '';
            const botNum = botFullId.replace(/[^0-9]/g, '');
            
            // ☢️ CONDICIÓN NUCLEAR: Detecta el perfil del bot bajo cualquier circunstancia (mención, texto o número)
            const isBotProfile = 
                (targetNum === numeroFijoBot) || 
                (botNum && targetNum === botNum) || 
                argTexto.includes('botcoco') || 
                argTexto.includes(numeroFijoBot);

            if (isBotProfile) {
                // Forzamos el JID del bot para que extraiga correctamente su foto de perfil
                const jidBotReal = numeroFijoBot + '@s.whatsapp.net';
                
                const perfilDiosTxt = `👤 *PERFIL DE USUARIO* 👤\n` +
                    `────────────────────────\n` +
                    `📌 *Usuario:* @Botcoco\n` +
                    `👑 *Rango:* DIOS\n` +
                    `⚧️ *Género / Categoría:* Entidad de Destrucción Universal / Deidad Nihilista\n` +
                    `💬 *Frase:* "Vi caer mil mundos y no moví un dedo para salvarlos; los dejé arder hasta los cimientos para demostrarles que no hay brazos divinos que los rescaten, y ahora caminan sobre mis cenizas esperando compasión de un creador que aprendió a disfrutar el silencio de sus gritos."\n` +
                    `🪙 *Soles:* Infinito ∞\n` +
                    `📊 *Mensajes:* 999,999,999`;

                let pfpUrl = null;
                try { pfpUrl = await sock.profilePictureUrl(jidBotReal, 'image').catch(() => null); } catch (err) {}

                if (pfpUrl) {
                    await sock.sendMessage(from, { image: { url: pfpUrl }, caption: perfilDiosTxt }, { quoted: m });
                } else {
                    await sock.sendMessage(from, { text: perfilDiosTxt }, { quoted: m });
                }
                return true;
            }

            // Perfil para usuarios normales
            if (!usersCollection) {
                await sock.sendMessage(from, { text: '❌ Error: Base de datos no conectada.' }, { quoted: m });
                return true;
            }

            const uData = await usersCollection.findOne({ jid: target }) || {};
            
            let statsData = {};
            if (from.endsWith('@g.us') && groupStatsCollection) {
                try {
                    statsData = await groupStatsCollection.findOne({ jid: target, groupId: from }) || {};
                } catch (e) {
                    console.log('Error leyendo groupStats:', e.message);
                }
            }
            
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

            const mentions = [target, ...parejas].filter(Boolean);

            let pfpUrl = null;
            try { pfpUrl = await sock.profilePictureUrl(target, 'image').catch(() => null); } catch (err) {}

            if (pfpUrl) {
                await sock.sendMessage(from, { image: { url: pfpUrl }, caption: perfilTxt, mentions }, { quoted: m });
            } else {
                await sock.sendMessage(from, { text: perfilTxt, mentions }, { quoted: m });
            }

            if (uData.stickerBase64) {
                try { await sock.sendMessage(from, { sticker: Buffer.from(uData.stickerBase64, 'base64') }); } catch {}
            }
            return true;
        }

    } catch (error) {
        console.error("Error crítico en perfil.js:", error);
    }
    
    return false;
}

module.exports = { handleCommand };