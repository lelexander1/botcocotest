const heistSessions = new Map();

async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command, groupsCollection, economyCollection, usersCollection } = ctx;
    const db = usersCollection || economyCollection;

    if (command === 'heist' || command === 'atraco') {
        const subCommand = args[0]?.toLowerCase();
        let session = heistSessions.get(from);

        if (!subCommand || subCommand === 'iniciar') {
            if (session) {
                await sock.sendMessage(from, { text: '⚠️ Ya hay un atraco organizándose. Usa *#heist unirse* para participar.' }, { quoted: m });
                return true;
            }

            heistSessions.set(from, {
                lider: sender,
                participantes: [sender],
                fase: 'reclutamiento'
            });

            await sock.sendMessage(from, { 
                text: `🚨 *¡SE PLANEA UN ATRACO AL BANCO!* 🚨\n\n@${sender.split('@')[0]} está organizando el golpe. Se necesitan hasta 4 personas.\n\n💬 Escribe *#heist unirse* para sumarte.\n⚡ Cuando estén listos, el líder escribe *#heist comenzar*.`,
                mentions: [sender]
            }, { quoted: m });
            return true;
        }

        if (subCommand === 'unirse') {
            if (!session || session.fase !== 'reclutamiento') {
                await sock.sendMessage(from, { text: '❌ No hay ningún atraco abierto para unirse.' }, { quoted: m });
                return true;
            }

            if (session.participantes.includes(sender)) {
                await sock.sendMessage(from, { text: '⚠️ Ya estás apuntado en este atraco.' }, { quoted: m });
                return true;
            }

            if (session.participantes.length >= 4) {
                await sock.sendMessage(from, { text: '⚠️ El equipo ya está completo (máximo 4 personas).' }, { quoted: m });
                return true;
            }

            if (db) {
                const userEco = await db.findOne({ jid: sender });
                const saldo = userEco?.soles || userEco?.wallet || 0;
                if (saldo < 1000) {
                    await sock.sendMessage(from, { text: `❌ Necesitas al menos 💰 *1,000 soles* en tu cuenta para el equipo inicial.` }, { quoted: m });
                    return true;
                }
            }

            session.participantes.push(sender);
            await sock.sendMessage(from, { 
                text: `✅ @${sender.split('@')[0]} se ha unido al equipo. (${session.participantes.length}/4 personas listas).`,
                mentions: [sender]
            }, { quoted: m });

            if (session.participantes.length === 4) {
                await ejecutarRobo(sock, from, session, db);
            }
            return true;
        }

        if (subCommand === 'comenzar' || subCommand === 'darle') {
            if (!session || session.fase !== 'reclutamiento') {
                await sock.sendMessage(from, { text: '❌ No hay ningún atraco en fase de reclutamiento.' }, { quoted: m });
                return true;
            }

            if (session.lider !== sender) {
                await sock.sendMessage(from, { text: '⚠️ Solo el líder puede arrancar el atraco antes.' }, { quoted: m });
                return true;
            }

            await ejecutarRobo(sock, from, session, db);
            return true;
        }
    }

    return false;
}

async function ejecutarRobo(sock, from, session, db) {
    const totalJugadores = session.participantes.length;
    session.fase = 'esperando_denuncia';

    try {
        if (db) {
            for (const participante of session.participantes) {
                await db.updateOne(
                    { jid: participante },
                    { $inc: { soles: -1000 } }
                );
            }
        }
    } catch (err) {
        console.error('Error descontando inversión:', err);
    }

    const botinTotal = totalJugadores * 12000; 

    let texto = `🏦 *¡EL GOLPE AL BANCO HA SIDO EJECUTADO!* 🏦\n\n`;
    texto += `👥 Ladrones en acción: *${totalJugadores} persona(s)*.\n`;
    texto += `💰 Botín en la maleta: *${botinTotal} soles*.\n\n`;
    texto += `🚨 *¡ATENCIÓN CIUDADANOS!* Los ladrones están huyendo con el dinero.\n`;
    texto += `📢 Cualquier miembro del grupo tiene *2 minutos* para escribir *#denuncairrobo* y delatarlos ante la policía. Si nadie los delata, se llevan todo limpio.`;

    const mentions = [...session.participantes];
    await sock.sendMessage(from, { text: texto, mentions });

    session.botinTotal = botinTotal;

    session.denunciaTimer = setTimeout(async () => {
        let activeSession = heistSessions.get(from);
        if (activeSession && activeSession.fase === 'esperando_denuncia') {
            heistSessions.delete(from);
            await repartirBotinIntegro(sock, from, activeSession, db);
        }
    }, 120000);
}

async function repartirBotinIntegro(sock, from, session, db) {
    try {
        const totalJugadores = session.participantes.length;
        const premioPorPersona = Math.floor(session.botinTotal / totalJugadores);

        if (db) {
            for (const participante of session.participantes) {
                await db.updateOne(
                    { jid: participante },
                    { $inc: { soles: premioPorPersona } },
                    { upsert: true }
                );
            }
        }

        let mensaje = `🎉 *¡HUIDA EXITOSA!* Nadie delató a los ladrones a tiempo.\n\n`;
        mensaje += `💵 El botín íntegro fue repartido: *+${premioPorPersona} soles* para cada uno. ¡Disfruten el dinero!`;

        const mentions = [...session.participantes];
        await sock.sendMessage(from, { text: mensaje, mentions });
    } catch (err) {
        console.error('Error al repartir botín íntegro:', err);
    }
}

module.exports = { handleCommand, heistSessions };