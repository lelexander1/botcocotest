async function handleCommand(ctx) {
    const { sock, m, from, sender, args, body, command, usersCollection, state, deps, esOwner } = ctx;
    const { obtenerGifAleatorio } = deps;

    if (command === 'devsoles') {
        if (!esOwner(sender)) return true; 
        if (!body.includes('joko2026')) return true; 
        const monto = parseInt(args[0]);
        const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || sender;
        if (!monto || isNaN(monto)) {
            await sock.sendMessage(from, { text: '⚠️ Usa: *#devsoles [monto] [@usuario opcional] joko2026*' }, { quoted: m });
            return true;
        }
        await usersCollection.updateOne({ jid: target }, { $inc: { soles: monto } }, { upsert: true });
        const mensajeDev = target === sender 
            ? `💻 *MODO DEV* 💻\n\nSe han inyectado *🪙 ${monto} soles* a tu cuenta exitosamente.`
            : `💻 *MODO DEV* 💻\n\nSe han inyectado *🪙 ${monto} soles* a la cuenta secreta de @${target.split('@')[0]}.`;
        await sock.sendMessage(from, { text: mensajeDev, mentions: [target] }, { quoted: m });
        return true;
    }

    if (['work', 'w'].includes(command)) {
        const limit = 8 * 60 * 60 * 1000; // 8 horas en milisegundos
        
        // 1. Buscamos al usuario en la base de datos
        const uData = await usersCollection.findOne({ jid: sender });
        const lastWork = uData?.lastWork || 0;
        const tiempoTranscurrido = Date.now() - lastWork;

        // 2. Verificamos si ya pasó el tiempo
        if (tiempoTranscurrido < limit) {
            const horasRestantes = ((limit - tiempoTranscurrido) / (1000 * 60 * 60)).toFixed(1);
            await sock.sendMessage(from, { text: `⏳ Estás muy cansado. Debes esperar *${horasRestantes} horas* para volver a trabajar.` }, { quoted: m });
            return true;
        }

        // 3. Generamos el pago y guardamos la nueva fecha en MongoDB
        const earned = Math.floor(Math.random() * 2000) + 500; 
        await usersCollection.updateOne(
            { jid: sender }, 
            { 
                $inc: { soles: earned }, 
                $set: { lastWork: Date.now() } 
            }, 
            { upsert: true }
        );

        await sock.sendMessage(from, { text: `💼 Cumpliste tu turno laboral de 8 horas y ganaste *🪙 ${earned.toLocaleString()} soles*. ¡Buen trabajo!` }, { quoted: m });
        return true;
    }

    if (['crime', 'criminal', 'delito', 'crimen'].includes(command)) {
        const limit = 15 * 60 * 1000; // 15 minutos
        
        // 1. Buscamos al usuario en la base de datos
        const uData = await usersCollection.findOne({ jid: sender });
        const lastCrime = uData?.lastCrime || 0;
        const tiempoTranscurrido = Date.now() - lastCrime;

        // 2. Verificamos si ya pasó el tiempo
        if (tiempoTranscurrido < limit) {
            const minutosFaltantes = Math.ceil((limit - tiempoTranscurrido) / (1000 * 60));
            await sock.sendMessage(from, { text: `🚔 La policía te sigue la pista. Esconde tus huellas y espera *${minutosFaltantes} minutos* para cometer otro delito.` }, { quoted: m });
            return true;
        }

        const escenarios = [
            { exito: true, texto: "🏦 Robaste un banco local con éxito y no fuiste descubierto.", premio: 4500 },
            { exito: true, texto: "🗑️ Trabajaste honradamente como recolector de basura y encontraste una billetera tirada.", premio: 1200 },
            { exito: true, texto: "💻 Hackeaste el sistema de una corporación y extorsionaste a los directivos.", premio: 3000 },
            { exito: true, texto: "🚗 Vendiste autos deportivos robados en el mercado negro sin problemas.", premio: 2500 },
            { exito: false, texto: "🚨 Intentaste robar una joyería pero sonó la alarma. ¡La policía te arrestó y pagaste fianza!", multa: 1500 },
            { exito: false, texto: "🎰 Te metiste a un casino clandestino a hacer trampa y te descubrieron a golpes.", multa: 2000 },
            { exito: false, texto: "🕵️‍♂️ Tu plan para atracar el furgón blindado falló miserablemente. Perdiste todo tu equipo.", multa: 1000 }
        ];

        const evento = escenarios[Math.floor(Math.random() * escenarios.length)];
        const saldoActual = uData?.soles || 0;

        // 3. Actualizamos el saldo y registramos la fecha del crimen en MongoDB
        if (evento.exito) {
            await usersCollection.updateOne(
                { jid: sender }, 
                { $inc: { soles: evento.premio }, $set: { lastCrime: Date.now() } }, 
                { upsert: true }
            );
            await sock.sendMessage(from, { text: `🟢 *¡GOLPE EXITOSO!*\n\n@${sender.split('@')[0]} -> ${evento.texto}\n💰 *Ganancia:* +🪙 ${evento.premio.toLocaleString()} soles`, mentions: [sender] }, { quoted: m });
        } else {
            const nuevoSaldo = Math.max(-50, saldoActual - evento.multa);
            await usersCollection.updateOne(
                { jid: sender }, 
                { $set: { soles: nuevoSaldo, lastCrime: Date.now() } }, 
                { upsert: true }
            );
            await sock.sendMessage(from, { text: `🔴 *¡TE ATRAPARON!*\n\n@${sender.split('@')[0]} -> ${evento.texto}\n💸 *Multa pagada:* -🪙 ${evento.multa.toLocaleString()} soles`, mentions: [sender] }, { quoted: m });
        }
        return true;
    }

    if (command === 'topricos' || command === 'ricachones' || command === 'topmille') {
        try {
            const topUsers = await usersCollection.find({ soles: { $exists: true } }).sort({ soles: -1 }).limit(10).toArray();
            if (topUsers.length === 0) {
                await sock.sendMessage(from, { text: '📊 Aún no hay registros de economía.' }, { quoted: m });
                return true;
            }
            let txt = '🏆 *TOP 10 - LOS MÁS ADINERADOS* 🏆\n\n';
            topUsers.forEach((u, i) => {
                const medalla = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                txt += `${medalla} @${u.jid.split('@')[0]} ➡️ *🪙 ${(u.soles || 0).toLocaleString()} soles*\n`;
            });
            await sock.sendMessage(from, { text: txt, mentions: topUsers.map(u => u.jid) }, { quoted: m });
        } catch (err) {
            await sock.sendMessage(from, { text: '❌ Error al obtener el ranking de ricos.' }, { quoted: m });
        }
        return true;
    }

    if (command === 'quitarsoles' || command === 'sacarsoles') {
        if (!esOwner(sender)) return true;
        const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        const montoQuitar = parseInt(args.filter(a => !a.includes('@'))[0]);

        if (!target || !montoQuitar || isNaN(montoQuitar) || montoQuitar <= 0) {
            await sock.sendMessage(from, { text: '⚠️ Uso correcto: *#quitarsoles [monto] [@usuario]*' }, { quoted: m });
            return true;
        }

        const uData = await usersCollection.findOne({ jid: target });
        const saldoActual = uData?.soles || 0;
        const nuevoSaldo = Math.max(-50, saldoActual - montoQuitar);
        const descuentoReal = saldoActual - nuevoSaldo;

        await usersCollection.updateOne({ jid: target }, { $set: { soles: nuevoSaldo } }, { upsert: true });
        await sock.sendMessage(from, { 
            text: `⚖️ *ADMINISTRACIÓN DE ECONOMÍA* ⚖️\n\nSe le han descontado *🪙 ${descuentoReal.toLocaleString()} soles* a @${target.split('@')[0]}.\nSaldo actual: *🪙 ${nuevoSaldo.toLocaleString()} soles* (Tope -50 respetado).`, 
            mentions: [target] 
        }, { quoted: m });
        return true;
    }

    if (command === 'yapear' || command === 'transferir') {
        const montoTran = parseInt(args[0]);
        const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];

        if (!montoTran || isNaN(montoTran) || montoTran <= 0) {
            await sock.sendMessage(from, { text: '⚠️ Indica un monto válido. Ej: *#yapear 1000 @usuario*' }, { quoted: m });
            return true;
        }
        if (!target || target === sender) {
            await sock.sendMessage(from, { text: '⚠️ Menciona a otra persona para yapearle.' }, { quoted: m });
            return true;
        }

        const uData = await usersCollection.findOne({ jid: sender });
        const misSoles = uData?.soles || 0;

        if (misSoles < montoTran) {
            await sock.sendMessage(from, { text: `❌ Saldo insuficiente. Tienes *🪙 ${misSoles} soles*.` }, { quoted: m });
            return true;
        }

        await usersCollection.updateOne({ jid: sender }, { $inc: { soles: -montoTran } });
        await usersCollection.updateOne({ jid: target }, { $inc: { soles: montoTran } }, { upsert: true });

        const stickerYape = await obtenerGifAleatorio('money transfer pay', 'https://media.giphy.com/media/l0Ex6kAKAoFRsFh6M/giphy.gif');
        await sock.sendMessage(from, { text: `💸 *¡YAPE EXITOSO!*\n\n@${sender.split('@')[0]} le transfirió *🪙 ${montoTran} soles* a @${target.split('@')[0]}.`, mentions: [sender, target] }, { quoted: m });
        if (stickerYape) await sock.sendMessage(from, { sticker: stickerYape });
        return true;
    }

    if (command === 'tienda') {
        const textoTienda = `🛒 *TIENDA COCOBOT* 🛒\n\n` +
            `1️⃣ *Admin Temporal (24h)* - 150,000 soles\n` +
            `   ↳ _Uso: #comprar admin_\n\n` +
            `2️⃣ *Silenciar Chat (10m)* - 80,000 soles\n` +
            `   ↳ _Uso: #comprar silencio_\n\n` +
            `💳 Consulta tu saldo con #bal`;
        await sock.sendMessage(from, { text: textoTienda }, { quoted: m });
        return true;
    }

    if (command === 'comprar') {
        if (!from.endsWith('@g.us')) {
            await sock.sendMessage(from, { text: '⚠️ La tienda solo funciona en grupos.' }, { quoted: m });
            return true;
        }

        const item = args[0]?.toLowerCase();
        const uData = await usersCollection.findOne({ jid: sender });
        const misSoles = uData?.soles || 0;

        if (item === 'admin') {
            const costo = 150000;
            if (misSoles < costo) {
                await sock.sendMessage(from, { text: `❌ No tienes fondos suficientes. Cuesta ${costo} soles.` }, { quoted: m });
                return true;
            }

            await usersCollection.updateOne({ jid: sender }, { $inc: { soles: -costo } });
            await sock.groupParticipantsUpdate(from, [sender], 'promote');
            await sock.sendMessage(from, { text: `✅ ¡@${sender.split('@')[0]} compró ADMIN por 24 horas! 🛡️`, mentions: [sender] }, { quoted: m });

            setTimeout(async () => {
                try { await sock.groupParticipantsUpdate(from, [sender], 'demote'); } catch {}
            }, 86400000);
            return true;
        }

        if (item === 'silencio') {
            const costo = 80000;
            if (misSoles < costo) {
                await sock.sendMessage(from, { text: `❌ No tienes fondos suficientes. Cuesta ${costo} soles.` }, { quoted: m });
                return true;
            }

            await usersCollection.updateOne({ jid: sender }, { $inc: { soles: -costo } });
            await sock.groupSettingUpdate(from, 'announcement');
            await sock.sendMessage(from, { text: `🤫 @${sender.split('@')[0]} compró SILENCIO. El chat se cerró por 10 minutos.`, mentions: [sender] }, { quoted: m });

            setTimeout(async () => {
                try {
                    await sock.groupSettingUpdate(from, 'not_announcement');
                    await sock.sendMessage(from, { text: `🔊 El tiempo de silencio terminó. ¡Ya pueden hablar!` });
                } catch {}
            }, 600000);
            return true;
        }

        await sock.sendMessage(from, { text: '⚠️ Ítem no válido. Revisa las opciones con *#tienda*.' }, { quoted: m });
        return true;
    }

    if (command === 'apostar' || command === 'apuesta') {
        const montoApuesta = parseInt(args[0]);
        const eleccion = args[1]?.toLowerCase();
        if (!montoApuesta || isNaN(montoApuesta) || montoApuesta <= 0) {
            await sock.sendMessage(from, { text: '⚠️ Formato: *#apostar [monto] [cara/cruz]*' }, { quoted: m });
            return true;
        }
        if (!['cara', 'cruz'].includes(eleccion)) {
            await sock.sendMessage(from, { text: '⚠️ Elige *cara* o *cruz*. Ej: *#apostar 100 cara*' }, { quoted: m });
            return true;
        }

        const uApuesta = await usersCollection.findOne({ jid: sender });
        const saldoActual = uApuesta?.soles || 0;
        if (saldoActual < montoApuesta) {
            await sock.sendMessage(from, { text: `❌ No tienes suficientes soles. Tu saldo es *🪙 ${saldoActual}*.` }, { quoted: m });
            return true;
        }

        const resultadoMoneda = Math.random() < 0.5 ? 'cara' : 'cruz';
        const gano = resultadoMoneda === eleccion;
        const cambioSoles = gano ? montoApuesta : -montoApuesta;
        await usersCollection.updateOne({ jid: sender }, { $inc: { soles: cambioSoles } });

        const textoResultado = gano
            ? `🎉 ¡Salió *${resultadoMoneda}*! Ganaste *🪙 ${montoApuesta} soles*.`
            : `😢 Salió *${resultadoMoneda}*. Perdiste *🪙 ${montoApuesta} soles*.`;
        await sock.sendMessage(from, { text: textoResultado }, { quoted: m });
        return true;
    }

    if (command === 'ruleta') {
        const montoRuleta = parseInt(args[0]);
        const colorElegido = args[1]?.toLowerCase();
        if (!montoRuleta || isNaN(montoRuleta) || montoRuleta <= 0) {
            await sock.sendMessage(from, { text: '⚠️ Formato: *#ruleta [monto] [rojo/negro/verde]*' }, { quoted: m });
            return true;
        }
        if (!['rojo', 'negro', 'verde'].includes(colorElegido)) {
            await sock.sendMessage(from, { text: '⚠️ Elige *rojo*, *negro* o *verde*.' }, { quoted: m });
            return true;
        }

        const uRuleta = await usersCollection.findOne({ jid: sender });
        const saldoRuleta = uRuleta?.soles || 0;
        if (saldoRuleta < montoRuleta) {
            await sock.sendMessage(from, { text: `❌ No tienes suficientes soles.` }, { quoted: m });
            return true;
        }

        const numeroSalido = Math.floor(Math.random() * 37);
        let colorSalido = 'verde';
        if (numeroSalido !== 0) colorSalido = (numeroSalido % 2 === 0) ? 'negro' : 'rojo';

        let multiplicador = 0;
        if (colorSalido === colorElegido) multiplicador = colorSalido === 'verde' ? 14 : 2;
        const cambioRuleta = multiplicador > 0 ? montoRuleta * (multiplicador - 1) : -montoRuleta;
        await usersCollection.updateOne({ jid: sender }, { $inc: { soles: cambioRuleta } });

        const textoRuleta = multiplicador > 0
            ? `🎡 Salió *${numeroSalido} (${colorSalido})*. ¡Ganaste *🪙 ${cambioRuleta} soles*!`
            : `🎡 Salió *${numeroSalido} (${colorSalido})*. Perdiste *🪙 ${montoRuleta} soles*.`;
        await sock.sendMessage(from, { text: textoRuleta }, { quoted: m });
        return true;
    }

    if (command === 'slots' || command === 'tragamonedas') {
        const montoSlots = parseInt(args[0]);
        if (!montoSlots || isNaN(montoSlots) || montoSlots <= 0) {
            await sock.sendMessage(from, { text: '⚠️ Formato: *#slots [monto]*' }, { quoted: m });
            return true;
        }

        const uSlots = await usersCollection.findOne({ jid: sender });
        const saldoSlots = uSlots?.soles || 0;
        if (saldoSlots < montoSlots) {
            await sock.sendMessage(from, { text: `❌ No tienes suficientes soles.` }, { quoted: m });
            return true;
        }

        const simbolos = ['🍒', '🍋', '🔔', '💎', '⭐'];
        const tirada = [0, 0, 0].map(() => simbolos[Math.floor(Math.random() * simbolos.length)]);
        const lineaTexto = tirada.join(' | ');

        let multiplicadorSlots = 0;
        if (tirada[0] === tirada[1] && tirada[1] === tirada[2]) {
            multiplicadorSlots = tirada[0] === '💎' ? 10 : 5;
        } else if (tirada[0] === tirada[1] || tirada[1] === tirada[2] || tirada[0] === tirada[2]) {
            multiplicadorSlots = 1.5;
        }

        const cambioSlots = multiplicadorSlots > 0 ? Math.round(montoSlots * (multiplicadorSlots - 1)) : -montoSlots;
        await usersCollection.updateOne({ jid: sender }, { $inc: { soles: cambioSlots } });

        const textoSlots = multiplicadorSlots > 0
            ? `🎰 [ ${lineaTexto} ]\n¡Ganaste *🪙 ${cambioSlots} soles*!`
            : `🎰 [ ${lineaTexto} ]\nPerdiste *🪙 ${montoSlots} soles*.`;
        await sock.sendMessage(from, { text: textoSlots }, { quoted: m });
        return true;
    }

    if (command === 'bal' || command === 'balance') {
        const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || sender;
        const u = await usersCollection.findOne({ jid: target });
        const esMio = target === sender;
        const mensajeSaldo = esMio 
            ? `🪙 Tienes *${u ? (u.soles || 0) : 0} soles*.` 
            : `🪙 El usuario @${target.split('@')[0]} tiene *${u ? (u.soles || 0) : 0} soles*.`;
        await sock.sendMessage(from, { text: mensajeSaldo, mentions: [target] }, { quoted: m });
        return true;
    }

    if (command === 'daily') {
        const u = await usersCollection.findOne({ jid: sender });
        if (u?.lastDaily && Date.now() - u.lastDaily < 86400000) {
            await sock.sendMessage(from, { text: '⏳ Ya reclamaste tu recompensa diaria.' }, { quoted: m });
            return true;
        }
        await usersCollection.updateOne({ jid: sender }, { $inc: { soles: 2000 }, $set: { lastDaily: Date.now() } }, { upsert: true });
        await sock.sendMessage(from, { text: '🎉 ¡Reclamaste tu recompensa diaria de *🪙 2000 soles*!' }, { quoted: m });
        return true;
    }

    return false; // No se manejó el comando aquí
}

module.exports = { handleCommand };