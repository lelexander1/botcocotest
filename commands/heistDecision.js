const { heistSessions } = require('./heist');

async function handleCommand(ctx) {
    const { sock, m, from, sender, command, usersCollection, economyCollection } = ctx;

    let session = heistSessions.get(from);

    if (session && session.fase === 'decision_herido') {
        // Validar que el usuario sea parte del equipo y NO sea el herido
        if (!session.participantes.includes(sender)) {
            return false; 
        }

        if (sender === session.usuarioHerido) {
            await sock.sendMessage(from, { text: `⚠️ ¡Estás herido en el suelo y no puedes votar, @${sender.split('@')[0]}! Espera a que tus compañeros decidan tu suerte.`, mentions: [sender] }, { quoted: m });
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

            // Si ya votaron todos los miembros sanos, cerramos la votación de inmediato
            if (votosActuales >= totalVotosNecesarios) {
                clearTimeout(session.votacionTimer);
                await finalizarVotacionHeist(sock, from, session, usersCollection || economyCollection);
            }

            return true;
        }
    }

    return false;
}

// Función que calcula la votación y reparte los premios
async function finalizarVotacionHeist(sock, from, session, dbCollection) {
    heistSessions.delete(from);

    let votosAyudar = 0;
    let votosAbandonar = 0;

    for (let voto of session.votos.values()) {
        if (voto === 'ayudar') votosAyudar++;
        else votosAbandonar++;
    }

    // Gana la opción con más votos. Si hay empate, gana 'abandonar'
    const decisionGanadora = votosAyudar >= votosAbandonar ? 'ayudar' : 'abandonar';
    const totalJugadores = session.participantes.length;
    let mensajeFinal = '';
    let gananciaPorPersona = 0;

    if (decisionGanadora === 'ayudar') {
        const botinReducido = Math.floor(session.botinActual * 0.7);
        gananciaPorPersona = Math.floor(botinReducido / totalJugadores);

        mensajeFinal = `📊 *¡RESULTADO DE LA VOTACIÓN (${votosAyudar} a ${votosAbandonar})!*\n\n`;
        mensajeFinal += `🤝 Decidieron ser solidarios y ayudaron a @${session.usuarioHerido.split('@')[0]}. ¡Lograron escapar todos juntos!\n\n`;
        mensajeFinal += `💵 Botín repartido: *+${gananciaPorPersona} soles* para cada uno.`;

    } else {
        mensajeFinal = `📊 *¡RESULTADO DE LA VOTACIÓN (${votosAbandonar} a ${votosAyudar})!*\n\n`;
        mensajeFinal += `🏃💨 Por mayoría, decidieron abandonar a @${session.usuarioHerido.split('@')[0]} para asegurar el botín.\n\n`;
        
        if (totalJugadores > 1) {
            const sanos = totalJugadores - 1;
            gananciaPorPersona = Math.floor(session.botinActual / sanos);
            mensajeFinal += `💵 El botín se repartió entre los ${sanos} sobrevivientes: *+${gananciaPorPersona} soles* cada uno.\n🚑 El compañero fue atrapado por la policía.`;
        } else {
            mensajeFinal += `Estabas tú solo, no había a quién ayudar y te atraparon intentando huir.`;
            gananciaPorPersona = 0;
        }
    }

    // Repartir el dinero en la base de datos
    if (dbCollection) {
        for (const participante of session.participantes) {
            if (decisionGanadora === 'abandonar' && participante === session.usuarioHerido) {
                continue; // El abandonado no gana nada
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

    const mentions = [...session.participantes];
    if (session.usuarioHerido && !mentions.includes(session.usuarioHerido)) {
        mentions.push(session.usuarioHerido);
    }

    await sock.sendMessage(from, { text: mensajeFinal, mentions });
}

module.exports = { handleCommand };