// Usamos un Map en memoria para almacenar las sesiones activas de atraco por grupo
const heistSessions = new Map();

async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command, groupsCollection, economyCollection } = ctx;

    // Log para verificar si el bot detecta el comando en los registros de Render
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

            // Creamos la sesión del atraco
            heistSessions.set(from, {
                lider: sender,
                participantes: [sender],
                fase: 'reclutamiento',
                timer: setTimeout(async () => {
                    // Si pasa 1 minuto y no arranca o faltan requisitos, se cancela
                    heistSessions.delete(from);
                    await sock.sendMessage(from, { text: '⏰ El tiempo de preparación expiró y el atraco fue cancelado por inactividad.' });
                }, 60000)
            });

            await sock.sendMessage(from, { 
                text: `🚨 *¡SE PLANEA UN ATRACO AL BANCO!* 🚨\n\n@${sender.split('@')[0]} está organizando el golpe. Se necesitan hasta 4 personas (Mínimo 1).\n\n💬 Escribe *#heist unirse* para sumarte al equipo.`,
                mentions: [sender]
            }, { quoted: m });
            return true;
        }

        // 2. UNIRSE AL EQUIPO
        if (subCommand === 'unirse') {
            if (!session || session.fase !== 'reclutamiento') {
                await sock.sendMessage(from, { text: '❌ No hay ningún atraco abierto para unirse en este momento. Usa *#heist iniciar* para crear uno.' }, { quoted: m });
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

            // Validar que tenga el capital mínimo (ej. 1000 monedas)
            if (economyCollection) {
                const userEco = await economyCollection.findOne({ userId: sender });
                const saldo = userEco?.wallet || 0;
                if (saldo < 1000) {
                    await sock.sendMessage(from, { text: `❌ No tienes suficiente dinero para comprar equipo inicial. Necesitas al menos 💰 *1,000 monedas* en tu billetera.` }, { quoted: m });
                    return true;
                }
            }

            session.participantes.push(sender);
            await sock.sendMessage(from, { 
                text: `✅ @${sender.split('@')[0]} se ha unido al equipo. (${session.participantes.length}/4 personas listas).`,
                mentions: [sender]
            }, { quoted: m });

            // Si ya llegaron a 4, podemos arrancar automáticamente
            if (session.participantes.length === 4) {
                clearTimeout(session.timer);
                await iniciarAtraco(sock, from, session, economyCollection);
            }
            return true;
        }

        // 3. FORZAR INICIO (Si el líder quiere arrancar con menos de 4)
        if (subCommand === 'comenzar' || subCommand === 'darle') {
            if (!session || session.fase !== 'reclutamiento') {
                await sock.sendMessage(from, { text: '❌ No hay ningún atraco en fase de reclutamiento.' }, { quoted: m });
                return true;
            }

            if (session.lider !== sender) {
                await sock.sendMessage(from, { text: '⚠️ Solo el líder que inició el atraco puede dar la orden de arrancar antes.' }, { quoted: m });
                return true;
            }

            clearTimeout(session.timer);
            await iniciarAtraco(sock, from, session, economyCollection);
            return true;
        }
    }

    return false;
}

// FUNCIÓN DE EJECUCIÓN DEL GOLPE Y TOMA DE DECISIONES
async function iniciarAtraco(sock, from, session, economyCollection) {
    const totalJugadores = session.participantes.length;
    session.fase = 'en_curso';

    // Descuento de 1000 monedas de equipamiento a cada participante
    if (economyCollection) {
        for (const participante of session.participantes) {
            await economyCollection.updateOne(
                { userId: participante },
                { $inc: { wallet: -1000 } }
            );
        }
    }

    // Escalado de recompensa: Menos jugadores = Mayor riesgo pero MUCHO más botín base
    const multiplicadorRiesgo = totalJugadores === 1 ? 2.5 : totalJugadores === 2 ? 1.8 : totalJugadores === 3 ? 1.3 : 1.0;
    const botinBase = Math.floor(15000 * multiplicadorRiesgo);

    let textoNarrativo = `🏦 *¡EL GOLPE AL BANCO HA COMENZADO!* 🏦\n\n`;
    textoNarrativo += `👥 Equipo operativo: *${totalJugadores} persona(s)*.\n`;
    textoNarrativo += `💰 Inversión inicial en equipos y armas: *1,000 monedas* por cabeza.\n\n`;
    textoNarrativo += `🚪 Entran sigilosamente al edificio central... desactivan las cámaras y abren la bóveda principal.\n`;
    
    // Evento aleatorio: Alguien resulta herido
    const heridoIndex = Math.floor(Math.random() * totalJugadores);
    const usuarioHerido = session.participantes[heridoIndex];

    textoNarrativo += `⚠️ *¡ALERTA ROJA!* La policía rodeó el perímetro inesperadamente y se desata un tiroteo. \n`;
    textoNarrativo += `🚑 ¡@${usuarioHerido.split('@')[0]} ha recibido un disparo y está gravemente herido en el suelo!\n\n`;
    textoNarrativo += `⚡ *DECISIÓN CRÍTICA:* ¿El equipo decide *#ayudar* al compañero cargándolo (lo que reduce el botín final pero salva su vida) o lo *#abandonan* para huir con todo el dinero?`;

    const mentions = [...session.participantes];

    await sock.sendMessage(from, { text: textoNarrativo, mentions });

    // Actualizamos la sesión para esperar la respuesta de decisión del grupo
    session.fase = 'decision_herido';
    session.usuarioHerido = usuarioHerido;
    session.botinActual = botinBase;

    // Timer de respuesta para la decisión (30 segundos)
    session.decisonTimer = setTimeout(async () => {
        if (heistSessions.has(from)) {
            heistSessions.delete(from);
            await sock.sendMessage(from, { text: '💀 Demoraron demasiado en decidir. La policía irrumpió y todos terminaron en la cárcel. ¡Perdieron la inversión!' });
        }
    }, 30000);
}

module.exports = { handleCommand, heistSessions };