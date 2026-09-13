const heistSessions = new Map();

async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command, usersCollection, economyCollection } = ctx;
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
                await iniciarRoboBanco(sock, from, session, db);
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

            await iniciarRoboBanco(sock, from, session, db);
            return true;
        }
    }

    return false;
}

// INICIA EL ROBO Y ABRE LA VENTANA DE 2 MINUTOS PARA DENUNCIAR
async function iniciarRoboBanco(sock, from, session, db) {
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

    const multiplicadorRiesgo = totalJugadores === 1 ? 2.5 : totalJugadores === 2 ? 1.8 : totalJugadores === 3 ? 1.3 : 1.0;
    session.botinActual = Math.floor(15000 * multiplicadorRiesgo);

    let texto = `🏦 *¡EL GOLPE AL BANCO HA COMENZADO!* 🏦\n\n`;
    texto += `👥 Equipo operativo: *${totalJugadores} persona(s)*.\n`;
    texto += `💰 Inversión inicial: *1,000 soles* por cabeza.\n\n`;
    texto += `🚪 La banda ha ingresado a la bóveda y está empaquetando el dinero.\n`;
    texto += `📢 Cualquier integrante del grupo tiene *2 minutos* para escribir *#denuncairrobo* y alertar a la policía. Si nadie los delata, escaparán con el botín limpio.`;

    const mentions = [...session.participantes];
    await sock.sendMessage(from, { text: texto, mentions });

    // Si pasan los 2 minutos (120,000 ms) y NADIE denunció, se escapan con éxito
    session.denunciaTimer = setTimeout(async () => {
        let activeSession = heistSessions.get(from);
        if (activeSession && activeSession.fase === 'esperando_denuncia') {
            heistSessions.delete(from);
            await repartirBotinExitoso(sock, from, activeSession, db);
        }
    }, 120000);
}

// SI NADIE DENUNCIA EN 2 MINUTOS: HUIDA EXITOSA
async function repartirBotinExitoso(sock, from, session, db) {
    try {
        const totalJugadores = session.participantes.length;
        const premioPorPersona = Math.floor(session.botinActual / totalJugadores);

        if (db) {
            for (const participante of session.participantes) {
                await db.updateOne(
                    { jid: participante },
                    { $inc: { soles: premioPorPersona + 1000 } }, // Devuelve su inversión + ganancias
                    { upsert: true }
                );
            }
        }

        let mensaje = `🎉 *¡HUIDA EXITOSA!* Pasaron los 2 minutos y nadie delató a los ladrones.\n\n`;
        mensaje += `💵 El botín fue repartido con éxito: *+${premioPorPersona} soles* para cada uno. ¡Golpe limpio!`;

        const mentions = [...session.participantes];
        await sock.sendMessage(from, { text: mensaje, mentions });
    } catch (err) {
        console.error('Error al repartir botín:', err);
    }
}

module.exports = { handleCommand, heistSessions, iniciarRoboBanco };