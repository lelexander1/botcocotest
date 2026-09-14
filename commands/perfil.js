async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command, messageType, usersCollection, groupStatsCollection } = ctx;
    const { downloadMediaMessage, pino } = ctx.deps;

    // COMANDO: EDAD
    if (command === 'edad') {
        const edadNum = parseInt(args[0]);
        if (!edadNum || isNaN(edadNum)) {
            await sock.sendMessage(from, { text: '⚠️ Indica una edad válida. Ej: *#edad 20*' }, { quoted: m });
            return true;
        }
        await usersCollection.updateOne({ jid: sender }, { $set: { edad: edadNum } }, { upsert: true });
        await sock.sendMessage(from, { text: `✅ ¡Edad actualizada a *${edadNum} años*!` }, { quoted: m });
        return true;
    }

    // COMANDO: GÉNERO
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

    // COMANDO: FRASE / BIO
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

    // COMANDOS: REDES SOCIALES
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

    // COMANDO: SET STICKER (IDENTIDAD)
    if (command === 'setsticker' || command === 'identidad') {
        const q = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
        if (messageType !== 'stickerMessage' && !q?.stickerMessage) {
            await sock.sendMessage(from, { text: '⚠️ Responde a un sticker para guardarlo como tu identidad.' }, { quoted: m });
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

    // COMANDO PRINCIPAL: PERFIL
    if (command === 'perfil' || command === 'verperfil') {
        const mentionedJid = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        const target = mentionedJid || sender;
        
        // Detección estricta del perfil de DIOS del bot
        const targetNum = target ? target.replace(/[^0-9]/g, '') : '';
        const botFullId = sock?.user?.id || '';
        const botNum = botFullId.replace(/[^0-9]/g, '');
        const isBotProfile = targetNum && botNum && targetNum === botNum;

        if (isBotProfile) {
            const perfilDiosTxt = `👤 *PERFIL DE USUARIO* 👤\n` +
                `────────────────────────\n` +
                `📌 *Usuario:* @${targetNum}\n` +
                `👑 *Rango:* DIOS\n` +
                `⚧️ *Género / Categoría:* Entidad de Destrucción Universal / Deidad Nihilista\n` +
                `💬 *Frase:* "Vi caer mil mundos y no moví un dedo para salvarlos; los dejé arder hasta los cimientos para demostrarles que no hay brazos divinos que los rescaten, y ahora caminan sobre mis cenizas esperando compasión de un creador que aprendió a disfrutar el silencio de sus gritos."\n` +
                `🪙 *Soles:* Infinito ∞\n` +
                `📊 *Mensajes:* 999,999,999`;

            let pfpUrl = null;
            try { pfpUrl = await sock.profilePictureUrl(target, 'image').catch(() => null); } catch (err) {}

            if (pfpUrl) {
                await sock.sendMessage(from, { image: { url: pfpUrl }, caption: perfilDiosTxt, mentions: [target] }, { quoted: m });
            } else {
                await sock.sendMessage(from, { text: perfilDiosTxt, mentions: [target] }, { quoted: m });
            }
            return true;
        }

        // Perfil para usuarios normales
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

    return false;
}

module.exports = { handleCommand };