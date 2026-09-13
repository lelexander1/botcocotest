const { heistSessions } = require('./heist');

async function handleCommand(ctx) {
    const { sock, m, from, sender, command, usersCollection, economyCollection } = ctx;
    const db = usersCollection || economyCollection;

    let session = heistSessions.get(from);

    if (!session) return false;

    // 1. SI ALGUIEN DENUNCIA EL ROBO DENTRO DE LOS 2 MINUTOS
    if (session.fase === 'esperando_denuncia') {
        if (command === 'denuncairrobo' || command === 'denunciar') {
            clearTimeout(session.denunciaTimer); // Cancelamos la huida limpia

            const totalJugadores = session.participantes.length;
            const heridoIndex = Math.floor(Math.random() * totalJugadores);
            const usuarioHerido = session.participantes[heridoIndex];
            const votantesHabiles = session.participantes.filter(p => p !== usuarioHerido);

            session.fase = 'decision_herido';
            session.usuarioHerido = usuarioHerido;
            session.votantesRequeridos = votantesHabiles.length;
            session.votos = new Map();

            let texto = `👮🚨 *¡LA POLICÍA FUE ALERTADA!* 🚨\n\n`;
            texto += `📢 ¡@${sender.split('@')[0]} usó *#denuncairrobo* y la policía rodeó el banco a tiempo!\n`;
            texto += `⚠️ Se desata un tiroteo en la huida y ¡@${usuarioHerido.split('@')[0]} ha recibido un disparo, está grave en el suelo y no puede votar!\n\n`;
            texto += `⚡ *DECISIÓN CRÍTICA:* Los demás (${votantesHabiles.length} miembros) tienen 40 segundos para votar escribiendo *#ayudar* o *#abandonar*.`;

            const mentions = [...session.participantes, sender];
            await sock.sendMessage(from, { text: texto, mentions }, { quoted: m });

            // Temporizador de votación de 40 segundos
            session.votacionTimer = setTimeout(async () => {
                let activeSession = heistSessions.get(from);
                if (activeSession && activeSession.fase === 'decision_herido') {
                    heistSessions.delete(from);
                    await sock.sendMessage(from, { text: '⏰ Demoraron demasiado decidiendo bajo presión. La policía los arrestó a todos y perdieron la inversión.' });
                }
            }, 40000);

            return true;
        }
    }

    // 2. FASE DE VOTACIÓN: AYUDAR O ABANDONAR AL COMPAÑERO HERIDO
    if (session.fase === 'decision_herido') {
        if (!session.participantes.includes(sender)) {
            return false; 
        }

        if (sender === session.usuarioHerido) {
            await sock.sendMessage(from, { text: `⚠️ ¡Estás herido en el suelo y no puedes votar, @${sender.split('@')[0]}!`, mentions: [sender] }, { quoted: m });
            return true;
        }

        if (command === 'ayudar' || command === 'abandonar' || command === 'abandonan') {
            if (!session.votos) {
                session.votos = new Map();
            }

            const votoNormalizado = command === 'ayudar' ? 'ayudar' : 'abandonar';
            session.votos.set(sender, votoNormalizado);
            
            const totalParticipantes = session.participantes.length;
            const totalVotosNecesarios = session.votantesRequeridos || (totalParticipantes - 1);
            const votosActuales = session.votos.size;

            await sock.sendMessage(from, { 
                text: `🗳️ Voto registrado de @${sender.split('@')[0]} (${votosActuales}/${totalVotosNecesarios} votos emitidos).`,
                mentions: [sender]
            }, { quoted: m });

            if (votosActuales >= totalVotosNecesarios) {
                clearTimeout(session.votacionTimer);
                await finalizarVotacionHeist(sock, from, session, db);
            }

            return true;
        }
    }

    return false;
}

// PROCESA LA VOTACIÓN TRAS LA INTERVENCIÓN POLICIAL
async function finalizarVotacionHeist(sock, from, session, dbCollection) {
    heistSessions.delete(from);

    let votosAyudar = 0;
    let votosAbandonar = 0;

    for (let voto of session.votos.values()) {
        if (voto === 'ayudar') votosAyudar++;
        else votosAbandonar++;
    }

    const decisionGanadora = votosAyudar >= votosAbandonar ? 'ayudar' : 'abandonar';
    const totalJugadores = session.participantes.length;
    let mensajeFinal = '';
    let gananciaPorPersona = 0;

    if (decisionGanadora === 'ayudar') {
        const botinReducido = Math.floor(session.botinActual * 0.6);
        gananciaPorPersona = Math.floor(botinReducido / totalJugadores);

        mensajeFinal = `📊 *¡RESULTADO DE LA VOTACIÓN (${votosAyudar} a ${votosAbandonar})!*\n\n`;
        mensajeFinal += `🤝 Decidieron arriesgarse y cargaron a @${session.usuarioHerido.split('@')[0]} esquivando a la policía.\n\n`;
        mensajeFinal += `💵 Rescate exitoso. Botín repartido: *+${gananciaPorPersona} soles* para cada uno.`;

    } else {
        mensajeFinal = `📊 *¡RESULTADO DE LA VOTACIÓN (${votosAbandonar} a ${votosAyudar})!*\n\n`;
        mensajeFinal += `🏃💨 Dejaron atrás a @${session.usuarioHerido.split('@')[0]} para escapar de la redada.\n\n`;
        
        if (totalJugadores > 1) {
            const sanos = totalJugadores - 1;
            gananciaPorPersona = Math.floor(session.botinActual / sanos);
            mensajeFinal += `💵 El botín se repartió entre los ${sanos} sobrevivientes: *+${gananciaPorPersona} soles* cada uno.\n🚑 El compañero herido fue capturado por las autoridades.`;
        } else {
            mensajeFinal += `Estabas tú solo, caíste herido y la policía te arrestó. ¡Perdiste todo!`;
            gananciaPorPersona = 0;
        }
    }

    try {
        if (dbCollection) {
            for (const participante of session.participantes) {
                if (decisionGanadora === 'abandonar' && participante === session.usuarioHerido) {
                    continue; 
                }
                if (gananciaPorPersona > 0) {
                    await dbCollection.updateOne(
                        { jid: participante },
                        { $inc: { soles: gananciaPorPersona } },
                        { upsert: true }
                    );
                }
            }
        }
    } catch (err) {
        console.error('Error al actualizar base de datos en tiroteo heist:', err);
    }

    const mentions = [...session.participantes];
    if (session.usuarioHerido && !mentions.includes(session.usuarioHerido)) {
        mentions.push(session.usuarioHerido);
    }

    await sock.sendMessage(from, { text: mensajeFinal, mentions });
}

module.exports = { handleCommand };