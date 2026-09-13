async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command, usersCollection, state, deps, esOwner } = ctx;
    const { obtenerGifAleatorio } = deps;

    if (command === 'del' || command === 'delete') {
        const info = m.message.extendedTextMessage?.contextInfo;
        if (!info?.stanzaId) {
            await sock.sendMessage(from, { text: '⚠️ Responde al mensaje que deseas eliminar con *#del*.' }, { quoted: m });
            return true;
        }

        const botNumber = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;
        const esMensajeDelBot = info.participant === botNumber || info.participant === sock.user.id;

        const keyParaBorrar = {
            remoteJid: from,
            id: info.stanzaId,
            fromMe: esMensajeDelBot,
            participant: info.participant
        };

        try { 
            await sock.sendMessage(from, { delete: keyParaBorrar }); 
        } catch (err) { 
            await sock.sendMessage(from, { text: '❌ No pude eliminar el mensaje. Si el mensaje es de otra persona, asegúrate de que tengo permisos de Administrador en el grupo.' }, { quoted: m }); 
        }
        return true;
    }

    if (command === 'divorcio') {
        const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        const tipo = args[1]?.toLowerCase() || 'normal';

        if (!target || target === sender) {
            await sock.sendMessage(from, { text: '⚠️ Menciona a la persona de la que deseas divorciarte.' }, { quoted: m });
            return true;
        }

        if (!['normal', 'juicio', 'encuesta'].includes(tipo)) {
            await sock.sendMessage(from, { text: '⚠️ Tipo de divorcio: *normal*, *juicio* o *encuesta*.' }, { quoted: m });
            return true;
        }

        const uData = await usersCollection.findOne({ jid: sender });
        const parejas = Array.isArray(uData?.pareja) ? uData.pareja : (uData?.pareja ? [uData.pareja] : []);

        if (!parejas.includes(target)) {
            await sock.sendMessage(from, { text: '⚠️ No estás casado/a con esa persona.' }, { quoted: m });
            return true;
        }

        if (tipo === 'normal') {
            await usersCollection.updateOne({ jid: sender }, { $pull: { pareja: target } });
            await usersCollection.updateOne({ jid: target }, { $pull: { pareja: sender } });
            await sock.sendMessage(from, {
                text: `💔 *DIVORCIO CONSUMADO* 💔\n\n@${sender.split('@')[0]} y @${target.split('@')[0]} han decidido separarse.\n\n_Las bendiciones terminaron. ¡Que encuentren paz!_ 🕊️`,
                mentions: [sender, target]
            }, { quoted: m });
        } else if (tipo === 'juicio') {
            if (state.juiciosActivos.has(from)) {
                await sock.sendMessage(from, { text: '⚠️ Ya hay un juicio activo en este grupo.' }, { quoted: m });
                return true;
            }

            state.juiciosActivos.set(from, { demandante: sender, demandado: target, monto: 0, votosSi: 0, votosNo: 0, votantes: new Set(), tipo: 'divorcio' });

            await sock.sendMessage(from, {
                text: `⚖️ *TRIBUNAL DE DIVORCIO* ⚖️\n\n💔 *Demandante:* @${sender.split('@')[0]}\n💔 *Demandado:* @${target.split('@')[0]}\n\n👨‍⚖️ *El jurado (ustedes) decide:*\n👉 Escriban *#culpable* para DIVORCIARSE.\n👉 Escriban *#inocente* para CONTINUAR JUNTOS.\n\n⏱️ El veredicto se dictará en 5 minutos.`,
                mentions: [sender, target]
            }, { quoted: m });
        } else if (tipo === 'encuesta') {
            state.encuestasDivorcio.set(from, { demandante: sender, demandado: target, siVotos: 0, noVotos: 0, votantes: new Set() });

            await sock.sendMessage(from, {
                text: `📋 *ENCUESTA DE DIVORCIO* 📋\n\n¿Debe separarse @${sender.split('@')[0]} de @${target.split('@')[0]}?\n\n👉 *#si* - Que se divorcien\n👉 *#no* - Que sigan juntos\n\n⏱️ Resultado en 3 minutos.`,
                mentions: [sender, target]
            }, { quoted: m });
        }
        return true;
    }

    if (command === 'si' || command === 'no') {
        const encuesta = state.encuestasDivorcio.get(from);
        if (encuesta && !encuesta.votantes.has(sender)) {
            encuesta.votantes.add(sender);
            if (command === 'si') encuesta.siVotos++;
            else encuesta.noVotos++;

            const resultado = `(Si: ${encuesta.siVotos} | No: ${encuesta.noVotos})`;
            await sock.sendMessage(from, { text: `✅ Voto registrado. ${resultado}` }, { quoted: m });
            return true;
        }
    }

    if (command === 'juicio' || command === 'demandar') {
        if (!from.endsWith('@g.us')) {
            await sock.sendMessage(from, { text: '⚠️ Los juicios solo proceden en grupos.' }, { quoted: m });
            return true;
        }
        if (state.juiciosActivos.has(from)) {
            await sock.sendMessage(from, { text: '⚠️ Ya hay un juicio activo en este grupo.' }, { quoted: m });
            return true;
        }

        const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!target) {
            await sock.sendMessage(from, { text: '⚠️ Menciona al acusado. Ej: *#juicio @usuario 5000 por feo*' }, { quoted: m });
            return true;
        }
        if (target === sender) {
            await sock.sendMessage(from, { text: '⚠️ No te puedes demandar a ti mismo.' }, { quoted: m });
            return true;
        }

        const argsSinMencion = args.filter(a => !a.includes('@'));
        const montoDemanda = parseInt(argsSinMencion[0]);
        if (!montoDemanda || isNaN(montoDemanda) || montoDemanda <= 0) {
            await sock.sendMessage(from, { text: '⚠️ Indica un monto válido de indemnización. Ej: *#juicio @usuario 5000 motivo*' }, { quoted: m });
            return true;
        }

        const motivo = argsSinMencion.slice(1).join(' ') || 'Sin motivo especificado';

        state.juiciosActivos.set(from, {
            demandante: sender, demandado: target, monto: montoDemanda, votosSi: 0, votosNo: 0, votantes: new Set()
        });

        await sock.sendMessage(from, {
            text: `⚖️ *TRIBUNAL DE COCOBOT* ⚖️\n\n🧑‍⚖️ *Demandante:* @${sender.split('@')[0]}\n🛑 *Acusado:* @${target.split('@')[0]}\n💸 *Indemnización Solicitada:* ${montoDemanda} soles\n📄 *Motivo:* "${motivo}"\n\n👨‍⚖️ *El jurado (ustedes) decide:*\n👉 Escriban *#culpable* para que pague la indemnización.\n👉 Escriban *#inocente* para absolverlo de los cargos.\n\n⏱️ El veredicto se dictará en 5 minutos.`,
            mentions: [sender, target]
        }, { quoted: m });

        setTimeout(async () => {
            const juicio = state.juiciosActivos.get(from);
            if (!juicio) return;
            state.juiciosActivos.delete(from);

            if (juicio.votosSi > juicio.votosNo) {
                const userDemandado = await usersCollection.findOne({ jid: juicio.demandado });
                const saldoActualDemandado = userDemandado?.soles || 0;
                const maximoDescuentoPermitido = saldoActualDemandado - (-50);
                const descuentoReal = maximoDescuentoPermitido > 0 ? Math.min(juicio.monto, maximoDescuentoPermitido) : 0;

                if (descuentoReal > 0) {
                    await usersCollection.updateOne({ jid: juicio.demandado }, { $inc: { soles: -descuentoReal } });
                    await usersCollection.updateOne({ jid: juicio.demandante }, { $inc: { soles: descuentoReal } });
                    await sock.sendMessage(from, { text: `⚖️ *VEREDICTO FINAL* ⚖️\n\nCon ${juicio.votosSi} votos a favor, declaran a @${juicio.demandado.split('@')[0]} *CULPABLE*.\n\n🔨 Como su cuenta tiene límite de deudas, pagó una indemnización parcial de *🪙 ${descuentoReal.toLocaleString()} soles* a @${juicio.demandante.split('@')[0]} (Tope de deuda alcanzado: -50).`, mentions: [juicio.demandado, juicio.demandante] });
                } else {
                    await sock.sendMessage(from, { text: `⚖️ *VEREDICTO FINAL* ⚖️\n\nEl jurado declaró a @${juicio.demandado.split('@')[0]} *CULPABLE*, ¡pero su cuenta está en la ruina total (-50 soles)! No se le pudo quitar más dinero por protección contra bancarrota. 🚫`, mentions: [juicio.demandado] });
                }
            } else {
                await sock.sendMessage(from, { text: `⚖️ *VEREDICTO FINAL* ⚖️\n\nCon ${juicio.votosNo} votos por la inocencia, @${juicio.demandado.split('@')[0]} es declarado *INOCENTE*.\n\n🔨 Caso cerrado.`, mentions: [juicio.demandado] });
            }
        }, 300000);

        return true;
    }

    if (command === 'culpable' || command === 'inocente') {
        const juicio = state.juiciosActivos.get(from);
        if (!juicio) return false; 
        if (juicio.votantes.has(sender)) {
            await sock.sendMessage(from, { text: '⚠️ Ya emitiste tu voto como jurado.' }, { quoted: m });
            return true;
        }

        juicio.votantes.add(sender);
        if (command === 'culpable') juicio.votosSi++;
        if (command === 'inocente') juicio.votosNo++;

        await sock.sendMessage(from, { text: `✅ Voto registrado. (Culpable: ${juicio.votosSi} | Inocente: ${juicio.votosNo})` }, { quoted: m });
        return true;
    }

    if (command === 'mutear' || command === 'mute') {
        if (!from.endsWith('@g.us')) {
            await sock.sendMessage(from, { text: '⚠️ Solo grupos.' }, { quoted: m });
            return true;
        }
        const meta = await sock.groupMetadata(from);
        const admins = meta.participants.filter(p => p.admin !== null).map(p => p.id);
        if (!admins.includes(sender) && !esOwner(sender)) {
            await sock.sendMessage(from, { text: '⚠️ Solo administradores pueden mutear.' }, { quoted: m });
            return true;
        }

        const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        const minutos = parseInt(args[1]) || 5; 
        if (!target) {
            await sock.sendMessage(from, { text: '⚠️ Menciona a quién silenciar. Ej: #mutear @usuario 10' }, { quoted: m });
            return true;
        }

        const bailAmount = minutos * 10000; 
        const expireTime = Date.now() + (minutos * 60000);

        state.mutedUsers.set(`${from}-${target}`, { expireTime, bailAmount, groupId: from });
        await sock.sendMessage(from, { text: `🔇 @${target.split('@')[0]} ha sido silenciado por ${minutos} minutos.\n\n💸 *Fianza:* ${bailAmount} soles.\n(Puede pagarla desde cualquier grupo usando #fianza)`, mentions: [target] }, { quoted: m });
        return true;
    }

    if (command === 'fianza' || command === 'pagarfianza') {
        let totalBail = 0;
        let muteKeysToRemove = [];

        for (const [key, info] of state.mutedUsers.entries()) {
            if (key.endsWith(`-${sender}`)) {
                if (Date.now() < info.expireTime) {
                    totalBail += info.bailAmount;
                    muteKeysToRemove.push(key);
                } else {
                    state.mutedUsers.delete(key);
                }
            }
        }

        if (muteKeysToRemove.length === 0) {
            await sock.sendMessage(from, { text: '✅ No tienes ninguna fianza pendiente ni estás silenciado.' }, { quoted: m });
            return true;
        }

        const uData = await usersCollection.findOne({ jid: sender });
        const misSoles = uData?.soles || 0;

        if (misSoles < totalBail) {
            await sock.sendMessage(from, { text: `❌ No tienes fondos para pagar tu fianza. Cuesta *🪙 ${totalBail} soles* y tienes *🪙 ${misSoles} soles*.` }, { quoted: m });
            return true;
        }

        await usersCollection.updateOne({ jid: sender }, { $inc: { soles: -totalBail } });
        muteKeysToRemove.forEach(k => state.mutedUsers.delete(k));

        await sock.sendMessage(from, { text: `✅ Has pagado tu fianza de *🪙 ${totalBail} soles*.\n¡Ya puedes volver a hablar en los grupos donde estabas silenciado! 🎉` }, { quoted: m });
        return true;
    }

    if (command === 'anuncio' || command === 'tagall' || command === 'todos') {
        if (!from.endsWith('@g.us')) {
            await sock.sendMessage(from, { text: '⚠️ Este comando solo se puede usar en grupos.' }, { quoted: m });
            return true;
        }

        try {
            const metadata = await sock.groupMetadata(from);
            const participantes = metadata.participants;
            const admins = participantes.filter(p => p.admin !== null).map(p => p.id);

            if (!admins.includes(sender) && !esOwner(sender)) {
                await sock.sendMessage(from, { text: '⚠️ Solo los administradores pueden usar este comando.' }, { quoted: m });
                return true;
            }

            const mensajeAnuncio = args.join(' ') || '¡Atención a todos!';
            let textoFinal = `📢 *ANUNCIO OFICIAL* 📢\n\n${mensajeAnuncio}`;
            const menciones = participantes.map(p => p.id);

            await sock.sendMessage(from, { text: textoFinal, mentions: menciones }, { quoted: m });
        } catch (err) {
            await sock.sendMessage(from, { text: '❌ No se pudo ejecutar el anuncio en este grupo.' }, { quoted: m });
        }
        return true;
    }

    if (command === 'kill' || command === 'ban') {
        if (!from.endsWith('@g.us')) {
            await sock.sendMessage(from, { text: '⚠️ Solo grupos.' }, { quoted: m });
            return true;
        }
        try {
            const meta = await sock.groupMetadata(from);
            const admins = meta.participants.filter(p => p.admin !== null).map(p => p.id);
            const botNumber = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;

            if (!admins.includes(sender) && !esOwner(sender)) {
                await sock.sendMessage(from, { text: '⚠️ Solo administradores.' }, { quoted: m });
                return true;
            }
            if (!admins.includes(botNumber)) {
                await sock.sendMessage(from, { text: '❌ El bot necesita ser admin.' }, { quoted: m });
                return true;
            }

            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.message.extendedTextMessage?.contextInfo?.participant;
            if (!target) {
                await sock.sendMessage(from, { text: '⚠️ Menciona al usuario.' }, { quoted: m });
                return true;
            }

            const stickerKill = await obtenerGifAleatorio('anime punch fight kick kickout', 'https://media.giphy.com/media/l1J9EdzfOSgfyfeLm/giphy.gif');
            await sock.sendMessage(from, { text: `💥 ¡Hasta la vista, @${target.split('@')[0]}!`, mentions: [target] }, { quoted: m });
            if (stickerKill) await sock.sendMessage(from, { sticker: stickerKill });
            await sock.groupParticipantsUpdate(from, [target], 'remove');
        } catch { 
            await sock.sendMessage(from, { text: '❌ No se pudo expulsar.' }, { quoted: m }); 
        }
        return true;
    }

    if (command === 'nsfw' || command === 'modohorny') {
        if (!esOwner(sender)) return true;
        const estado = args[0]?.toLowerCase();

        if (estado === 'off' || estado === 'apagar') {
            state.nsfwHabilitado = false;
            await sock.sendMessage(from, { text: '🔒 Comandos +18 *desactivados* globalmente.' }, { quoted: m });
        } else if (estado === 'on' || estado === 'encender') {
            state.nsfwHabilitado = true;
            await sock.sendMessage(from, { text: '🔓 Comandos +18 *activados* globalmente.' }, { quoted: m });
        } else {
            const panelText = `🎛️ *PANEL DE CONTROL NSFW* 🎛️\n\n` +
                `Estado actual: *${state.nsfwHabilitado ? 'ACTIVADO 🟢' : 'DESACTIVADO 🔴'}*\n\n` +
                `Selecciona una opción:\n` +
                `👉 Escribe *#nsfw on* para encender\n` +
                `👉 Escribe *#nsfw off* para apagar`;
            await sock.sendMessage(from, { text: panelText }, { quoted: m });
        }
        return true;
    }

    return false;
}

module.exports = { handleCommand };