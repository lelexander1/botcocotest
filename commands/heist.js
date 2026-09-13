// Usamos un Map en memoria para almacenar las sesiones activas de atraco por grupo
const heistSessions = new Map();

async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command, groupsCollection, economyCollection } = ctx;

    console.log(`[Heist Debug] Comando recibido: "${command}" en el chat: ${from}`);

    if (command === 'heist' || command === 'atraco') {
        const subCommand = args[0]?.toLowerCase();
        let session = heistSessions.get(from);

        // 1. INICIAR RECLUTAMIENTO
        if (!subCommand || subCommand === 'iniciar') {
            if (session) {
                await sock.sendMessage(from, { text: '⚠️ Ya hay un atraco organizándose en este grupo. Usa *#heist unirse* para participar.' }, { quoted: m });
                return true;
            }

            heistSessions.set(from, {
                lider: sender,
                participantes: [sender],
                fase: 'reclutamiento'
            });

            await sock.sendMessage(from, { 
                text: `🚨 *¡SE PLANEA UN ATRACO AL BANCO!* 🚨\n\n@${sender.split('@')[0]} está organizando el golpe. Se necesitan hasta 4 personas.\n\n💬 Escribe *#heist unirse* para sumarte.\n⚡ Cuando estén listos, el líder puede escribir *#heist comenzar* para arrancar.`,
                mentions: [sender]
            }, { quoted: m });
            return true;
        }

        // 2. UNIRSE AL EQUIPO
        if (subCommand === 'unirse') {
            if (!session || session.fase !== 'reclutamiento') {
                await sock.sendMessage(from, { text: '❌ No hay ningún atraco abierto para unirse. Usa *#heist iniciar* para crear uno.' }, { quoted: m });
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

            const colABuscar = economyCollection || ctx.usersCollection;
            if (colABuscar) {
                const userEco = await colABuscar.findOne({ jid: sender });
                const saldo = userEco?.soles || userEco?.wallet || 0;
                if (saldo < 1000) {
                    await sock.sendMessage(from, { text: `❌ No tienes suficiente dinero. Necesitas al menos 💰 *1,000 soles* en tu cuenta.` }, { quoted: m });
                    return true;
                }
            }

            session.participantes.push(sender);
            await sock.sendMessage(from, { 
                text: `✅ @${sender.split('@')[0]} se ha unido al equipo. (${session.participantes.length}/4 personas listas).`,
                mentions: [sender]
            }, { quoted: m });

            if (session.participantes.length === 4) {
                await iniciarAtraco(sock, from, session, colABuscar);
            }
            return true;
        }

        // 3. FORZAR INICIO MANUAL
        if (subCommand === 'comenzar' || subCommand === 'darle') {
            if (!session || session.fase !== 'reclutamiento') {
                await sock.sendMessage(from, { text: '❌ No hay ningún atraco en fase de reclutamiento.' }, { quoted: m });
                return true;
            }

            if (session.lider !== sender) {
                await sock.sendMessage(from, { text: '⚠️ Solo el líder que inició el atraco puede dar la orden de arrancar.' }, { quoted: m });
                return true;
            }

            const colABuscar = economyCollection || ctx.usersCollection;
            await iniciarAtraco(sock, from, session, colABuscar);
            return true;
        }
    }

    return false;
}

// FUNCIÓN DE EJECUCIÓN DEL GOLPE
async function iniciarAtraco(sock, from, session, dbCollection) {
    const totalJugadores = session.participantes.length;
    session.fase = 'en_curso';

    if (dbCollection) {
        for (const participante of session.participantes) {
            await dbCollection.updateOne(
                { jid: participante },
                { $inc: { soles: -1000 } }
            );
        }
    }

    const multiplicadorRiesgo = totalJugadores === 1 ? 2.5 : totalJugadores === 2 ? 1.8 : totalJugadores === 3 ? 1.3 : 1.0;
    const botinBase = Math.floor(15000 * multiplicadorRiesgo);

    let textoNarrativo = `🏦 *¡EL GOLPE AL BANCO HA COMENZADO!* 🏦\n\n`;
    textoNarrativo += `👥 Equipo operativo: *${totalJugadores} persona(s)*.\n`;
    textoNarrativo += `💰 Inversión inicial: *1,000 soles* por cabeza.\n\n`;
    textoNarrativo += `🚪 Entran sigilosamente al edificio central... desactivan las cámaras y abren la bóveda principal.\n`;
    
    const heridoIndex = Math.floor(Math.random() * totalJugadores);
    const usuarioHerido = session.participantes[heridoIndex];

    // Definimos qué miembros son los votantes hábiles (excluyendo al herido)
    const votantesHabiles = session.participantes.filter(p => p !== usuarioHerido);

    textoNarrativo += `⚠️ *¡ALERTA ROJA!* La policía rodeó el perímetro y se desata un tiroteo.\n`;
    textoNarrativo += `🚑 ¡@${usuarioHerido.split('@')[0]} ha recibido un disparo, está herido y no puede votar!\n\n`;
    textoNarrativo += `⚡ *DECISIÓN CRÍTICA:* Los demás (${votantesHabiles.length} miembros) deben votar escribiendo *#ayudar* o *#abandonar*.`;

    const mentions = [...session.participantes];
    await sock.sendMessage(from, { text: textoNarrativo, mentions });

    session.fase = 'decision_herido';
    session.usuarioHerido = usuarioHerido;
    session.botinActual = botinBase;
    session.votantesRequeridos = votantesHabiles.length; // Guardamos cuántos votos se necesitan en total
    session.votos = new Map();

    // Ampliamos el temporizador a 40 segundos para dar tiempo a leer y debatir
    session.votacionTimer = setTimeout(async () => {
        let activeSession = heistSessions.get(from);
        if (activeSession && activeSession.fase === 'decision_herido') {
            heistSessions.delete(from);
            await sock.sendMessage(from, { text: '⏰ El tiempo de votación terminó. El atraco fracasó por indecisión y la policía los atrapó.' });
        }
    }, 40000);
}

module.exports = { handleCommand, heistSessions };