const FileStorage = require('./S3');
const MessagingChannel = require('./Facebook');
const NLPMotor = require('./Dialogflow');
const Usuario = require('./Usuario');
const MaterialEstudio = require('./MaterialEstudio');
const Archivo = require('./Archivo');
const DataBase = require('./MySQLDataBase');
const Curso = require('./Curso');
const CacheHandler = require('./CacheHandler');

class Bot {
    constructor(cacheTime, greetingsMessage, mediaFolder) {
        this.greetingsMessage = greetingsMessage;
        this.mediaFolder = mediaFolder;
        /**
         * @property
         * @type {CacheHandler}
         */
        this.CacheHandler = new CacheHandler(cacheTime);
        /**
         * @property FileStorage
         * @type {FileStorage}
         */
        this.FileStorage = null;
        /**
         * @property MessagingChannel
         * @type {MessagingChannel}
         */
        this.MessagingChannel = null;
        /**
         * @property NLPMotor
         * @type {NLPMotor}
         */
        this.NLPMotor = null;
        /**
         * @property DataBase
         * @type {DataBase}
         */
        this.DataBase = null;

    }
}

/**
 *
 * @param {Number} reconnectionTime
 * @returns {Promise<*>}
 */
Bot.prototype.init = function (reconnectionTime) {
    return this.DataBase.connect(reconnectionTime, true);
};
/**
 * @method setFileStorage
 * Determina el Almacenamiento de archivos a usar para distribuir el material de estudio
 * @param {FileStorage} FileStorage
 */
Bot.prototype.setFileStorage = function (FileStorage) {
    this.FileStorage = FileStorage;
};
/**
 * Determina la base de datos que se usara para manejar las solicitudes
 * @param {DataBase} DataBase
 */
Bot.prototype.setDataBase = function (DataBase) {
    this.DataBase = DataBase;
};
/**
 * @method setMessagingChannel
 * Determina el canal de mensajeria para poder comunicarse con los usuarios
 * @param {MessagingChannel} MessagingChannel
 */
Bot.prototype.setMessagingChannel = function (MessagingChannel) {
    this.MessagingChannel = MessagingChannel;
};
/**
 * Determina el motor de procesamiento de lenguaje natural a usar en las conversaciones con los usuarios
 * @method
 * @name setNLPMotor
 * @param {NLPMotor} NLPMotor
 */
Bot.prototype.setNLPMotor = function (NLPMotor) {
    this.NLPMotor = NLPMotor;
};
/**
 * @method
 * @name createUser
 * @param {Number} userId
 * @returns {Promise<Usuario>}
 */
Bot.prototype.createUser = function (userId) {
  const welcomeFileLocation = this.mediaFolder + '/welcome';
  let type;
  return this.DataBase.createUser(userId)
    .then(user => this.MessagingChannel.sendText(userId, this.greetingsMessage, false))
    .then(() => this.FileStorage.listObjectsUnder(welcomeFileLocation))
    .then(welcomeFiles => welcomeFiles
      .filter(file => file.indexOf('.') !== -1)
      .map(file => new Archivo(file))[0])
    .then(file => {
      return this.FileStorage.getPublicURL(file.getKey())
        .then(url => {
          return {
            type : file.getType(),
            url : url,
            attachment_id : ''
          }
        })
    })
    .then(file => this.MessagingChannel.sendAttachment(userId, file))
    .catch(e => this.DataBase.logUserError(e, user, 'MessagingChannel'));
};
/**
 * Inicia la interaccion con un usuario, devolviendo una instancia de la clase usuario, que sera necesaria para el
 * desarrollo de siguientes metodos
 * @param {Number} userId
 * @returns {Promise<User>}
 */
Bot.prototype.startInteraction = function (userId) {
    return this.MessagingChannel.startInteraction(userId)
        .catch(e => this.DataBase.logUserError(e, new Usuario(userId), 'MessagingChannel'))
        .then(() => this.DataBase.getUserById(userId))
        .then(user =>  {
            if (!user) return this.createUser(userId);
            return Promise.resolve(user);
        });
};
/**
 * Determina los posibles cursos a los que un usuario puede referirse con un mensaje de texto
 * @param {Usuario} user
 * @param {String} message
 * @returns {Promise<Curso[]>}
 */
Bot.prototype.detectCourses = function (user, message) {
    if (!user.isAbleToRequestCourses()) return Promise.resolve([]);
    message = message.removeTildesLower();
    const completeWords = message.split(' ');
    const words = completeWords.filter(word => word.length >= 5);
    return this.DataBase.getProbableCoursesByUser(user)
        .catch(e => this.DataBase.logUserError(e, user, 'DataBase'))
        .then(courses => {
            const nonZeroMatch = courses.filter(course => {
                for (let word of words) {
                    if (course.matchesName(word)) return true;
                }
                return false;
            });
            //TODO Priorizar por ciclo
            const exactMatch = nonZeroMatch.filter(course => {
                if (course.matchesName(message)) return true;
                for (let word of completeWords) {
                    if (!course.matchesName(word)) return false;
                }
                return true;
            });
            if (exactMatch.length > 0) return exactMatch;
            return nonZeroMatch.sort((course1, course2) => {
                let score1 = 0, score2 = 0;
                for (let word of words) {
                    if (course1.matchesName(word)) score1++;
                    if (course2.matchesName(word)) score2++;
                }
                return score1 - score2;
            });
        })
};

/**
 *
 * @param {Usuario} user
 * @param {Curso[]} courses
 * @returns {Promise<T>}
 */
Bot.prototype.sendCourses = function (user, courses) {
    const options = Array.shuffle(courses.map(course => {
        const option = {};
        const data = course.getData();
        option['title'] = data['Nombre'].toUpperCase();
        option['subtitle'] = `Sis. de evaluación: ${data['SistemaEvaluacion']}\nCréditos: ${data['Creditos']}`;
        option['buttons'] = [
            {
                'title' : `MATERIAL ${data['Codigo']}`,
                'payload' : `SetCurso:${data['Codigo']}`
            }
        ];
        return option;
    }));
    const id = user.getFacebookId();
    return this.MessagingChannel.sendOptionsMenu(id, options)
        .catch(e => this.DataBase.logInternalError(e, 'MessagingChannel'))
        .catch(e => console.log(e));
};

/**
 * Determina las posibles carpetas a las que se refiere un usuario con un mensaje
 * @param {Usuario} user
 * @param {String} message
 * @returns {Promise<String[]>}
 */
Bot.prototype.detectFolders = function (user, message) {
    if (!user.isAbleToRequestFolders()) return Promise.resolve([]);
    const Especialidad = user.getEspecialidad();
    const Curso = user.getCurso();
    return this.DataBase.getEspecialidadById(Especialidad)
        .then(rows => {
            const Facultad = rows[0]['Facultad'];
            const prefix = `${Facultad}/${Curso}/`;
            const cachedFolders = this.CacheHandler.get(prefix);
            if (cachedFolders) return cachedFolders;
            return this.FileStorage.listObjectsDirectlyUnder(prefix)
                .then(respuesta => {
                    const Folders = respuesta.map(o => o.replace(prefix, '').replace('/',''));
                    this.CacheHandler.set(prefix, Folders);
                    return Folders;
                });
        })
        .then(Carpetas => {
            return Carpetas.filter(Carpeta => {
                if (message.length === 0) return true;
                message = message.removeTildesLower();
                if (Carpeta.indexOf(message) > 0) return true;
                const carpeta = new RegExp(Carpeta.replace(/-/g, '(|-| )'), 'i');
                return carpeta.test(message);
            });
        });
};

/**
 *
 * @param {Usuario} user
 * @param {String[]} folders
 * @returns {Promise}
 */
Bot.prototype.sendFolders = function (user, folders) {
    const userId = user.getFacebookId();
    const buttons = folders.map(folder => {
        return {
            'title' : folder.replace(/-/g,' '),
            'payload' : `SetCarpeta:${folder}`
        }
    });
    const text = 'Quisiera que me muestres las carpetas';
    const Curso = user.getCurso();
    return this.NLPMotor.processText(userId, text)
        .then(response => response['text'].replace('***', Curso))
        .then(Text => this.MessagingChannel.sendReplyButtons(userId, Text, buttons))
        .catch(e => this.DataBase.logInternalError(e, 'MessagingChannel'));
};

/**
 *
 * @param {Usuario} user
 * @param {String} message
 * @returns {Promise<MaterialEstudio[]>}
 */
Bot.prototype.detectFiles = function (user, message) {
    if (!user.isAbleToRequestFiles()) return Promise.resolve([]);
    const Especialidad = user.getEspecialidad();
    const Curso = user.getCurso();
    const Carpeta = user.getCarpeta();
    let prefix = '';
    return this.DataBase.getEspecialidadById(Especialidad)
        .then(rows => {
            const Facultad = rows[0]['Facultad'];
            prefix = `${Facultad}/${Curso}/${Carpeta}/`;
            const cachedFiles = this.CacheHandler.get(prefix);
            if (cachedFiles) return cachedFiles;
            return this.FileStorage.listObjectsUnder(prefix);
        })
        .then(respuesta => {
            respuesta = respuesta.filter(key => key.indexOf('.') !== -1);
            this.CacheHandler.set(prefix, respuesta);
            return Promise.all(respuesta.map(key => this.DataBase.getFileByKey(key)));
        })
        .then(Files => Files.filter(file => file.matchesText(message)));
};
/**
 *
 * @param {Usuario} user
 * @param {MaterialEstudio[]} files
 * @returns {Promise}
 */
Bot.prototype.sendFiles = function (user, files) {
    if (files.length === 0) {
        return this.DataBase.logUserError(new Error('No hay archivos para enviar.'), user, 'DataBase');
    }
    user.aumentaPeticion();
    const userId = user.getFacebookId();
    let shortName = '';
    let SortedFiles = [];
    // Se mapea cada archivo a una promesa que contendra todos los parametros necesarios para hacer las requests
    return Promise.all(files.sort((file1, file2) => file1.getPage() - file2.getPage()))
        .catch(e => this.DataBase.logInternalError(e, 'Archivo'))
        .then(sortedFiles => {
            SortedFiles = sortedFiles;
            return Promise.all(sortedFiles.map(file => {
                return new Promise((resolve, reject) => {
                    shortName = file.getShortName();
                    const type = file.getType();
                    const params = {
                        'type': type,
                        'attachment_id': null,
                        'url': null
                    };
                    const reuseId = file.getReuseId();
                    if (reuseId !== null) {
                        params['attachment_id'] = reuseId;
                        return resolve(params);
                    }
                    const key = file.getKey();
                    this.FileStorage.getPublicURL(key)
                        .then(url => {
                            params['url'] = url;
                            resolve(params)
                        })
                        .catch(e => reject(e))
                })
            }))
        }) //Se envian luego de forma secuencial al usuario
        .then(parameters => this.MessagingChannel.sendSecuentialAttachments(userId, parameters))
        .then(responses => {
            let failed = false;
            for (let i = 0; i < responses.length; i++) {
                const response = responses[i];
                const file = SortedFiles[i];
                const key = file.getKey();
                if (response instanceof Error) {
                    failed = true;
                    this.DataBase.logUserError(response, user, 'MessagingChannel')
                        .then(() => this.DataBase.logTransaction(user, key, false))
                        .catch(e => console.log(e));
                } else {
                    this.DataBase.logTransaction(user, key, true)
                        .then(() => {
                            file.aumentaContador();
                            if (!file.getReuseId()) {
                                const attachment_id = parseInt(response['attachment_id']) || null;
                                file.setReuseId(attachment_id);
                            }
                            return this.DataBase.updateFile(file, user)
                        })
                        .catch(e => this.DataBase.logUserError(e, user, 'DataBase'))
                        .catch(e => console.log(e));
                }
            }
            const e = new Error('Failed to send files');
            return failed ? Promise.reject(e) : Promise.resolve();
        })
        .then(() => this.sendAvailableFiles(user))
        .catch((e) => {
            const buttons = [
                {
                    'title' : 'Sí',
                    'payload' : `SetArchivo:${shortName}`
                },
                {
                    'title' : 'No',
                    'payload' : `SetCarpeta:${user.getCarpeta()}`
                }
            ];
            const text = 'Error enviando. ¿Quieres intentarlo de nuevo?';
            return this.DataBase.logUserError(e, user, 'MessagingChannel')
                .then(() => this.MessagingChannel.sendReplyButtons(userId, text, buttons))
        })
        .catch(e => console.log(e));
};
/**
 *
 * @param {Usuario} user
 * @param {MaterialEstudio[]} files
 * @returns {Promise}
 */
Bot.prototype.sendFileOptions = function (user, files) {
    const userId = user.getFacebookId();
    const buttons = files
        .map(file => file.getShortName())
        .filter((value, index, self) => self.indexOf(value) === index)
        .map(File => {
            return {
                'title' : File,
                'payload' : `SetArchivo:${File}`
            }
        });
    const text = 'Quisiera que me muestres los archivos';
    const Carpeta = user.getCarpeta();
    return this.NLPMotor.processText(userId, text)
        .then(response => response['text'].replace('***', Carpeta))
        .then(Text => this.MessagingChannel.sendReplyButtons(userId, Text, buttons))
        .catch(e => this.DataBase.logInternalError(e, 'MessagingChannel'));

};
/**
 *
 * @param {Usuario} user
 * @returns {Promise}
 */
Bot.prototype.regularizeUser = function (user) {
    const userId = user.getFacebookId();
    if (!user.getEspecialidad()) {
        const message = 'Selecciona una Facultad';
        return this.DataBase.getFacultades()
            .then(rows => {
                const buttons = rows.map(row => {
                    return {
                        'title' : row['Id'],
                        'payload' : `SetFacultad:${row['Id']}`
                    }
                });
                return this.MessagingChannel.sendReplyButtons(userId, message, buttons);
            })
            .catch(e => this.DataBase.logUserError(e, user, 'MessagingChannel'));
    } else if (!user.getCiclo()) {
        const message = 'Selecciona un ciclo';
        return this.DataBase.getCiclos()
            .catch(e => this.DataBase.logUserError(e, user, 'DataBase'))
            .then(ciclos => {
                const buttons = ciclos.map(ciclo => {
                    return {
                        'title' : ciclo['Nombre'],
                        'payload' : `SetCiclo:${ciclo['Nombre']}`
                    }
                });
                return this.MessagingChannel.sendReplyButtons(userId, message, buttons);
            })
            .catch(e => this.DataBase.logUserError(e, user, 'MessagingChannel'));
    } else {
        return Promise.resolve();
    }
};
/**
 *
 * @param {Usuario} user
 * @returns {Promise}
 */
Bot.prototype.sendAvailableCourses = function (user) {
    return this.DataBase.getCoursesByUser(user)
        .catch(e => this.DataBase.logUserError(e, user, 'DataBase'))
        .then(courses => this.sendCourses(user, courses))
        .catch(e => this.DataBase.logInternalError(e, 'MessagingChannel'));
};
/**
 *
 * @param {Usuario} user
 * @returns {Promise}
 */
Bot.prototype.sendAvailableFolders = function (user) {
    const userId = user.getFacebookId();
    return this.detectFolders(user, '')
        .then(folders => {
            const negationMessage = 'No hay carpetas disponibles, considera donar tu material de estudio en este curso.';
            if (folders.length === 0) return this.MessagingChannel.sendText(userId, negationMessage, false);
            return this.sendFolders(user, folders)
        });
};
/**
 *
 * @param {Usuario} user
 * @returns {Promise}
 */
Bot.prototype.sendAvailableFiles = function (user) {
    return this.detectFiles(user, '')
        .then(files => this.sendFileOptions(user, files));
};
/**
 *
 * @param {Usuario} user
 * @param {String} command
 * @param {Object} parameters
 * @returns {Promise}
 */
Bot.prototype.executeCommand = function (user, command, parameters) {
    const userId = user.getFacebookId();
    switch (command) {
        case 'Empezar':
            return this.regularizeUser(user);
        case 'ResetEspecialidad':
            user.setEspecialidad(null);
            return this.regularizeUser(user);
        case 'ResetCiclo':
            user.setCiclo(null);
            return this.regularizeUser(user);
        case 'Cursos':
            if (!user.isAbleToRequestCourses()) return this.regularizeUser(user);
            return this.sendAvailableCourses(user);
        case 'SetFacultad':
            const message = 'Selecciona una especialidad';
            const Facultad = parameters['facultad'] || parameters;
            return this.DataBase.getEspecialidadesByFacultad(Facultad)
                .catch(e => this.DataBase.logUserError(e, user, 'DataBase'))
                .then(rows => {
                    const buttons = rows.map(row => {
                        return {
                            'title' : row['Id'],
                            'payload' : `SetEspecialidad:${row['Id']}`
                        }
                    });
                    return this.MessagingChannel.sendReplyButtons(userId, message, buttons);
                })
                .catch(e => this.DataBase.logUserError(e, user, 'MessagingChannel'));
        case 'SetEspecialidad':
            const Especialidad = parameters['especialidad'] || parameters;
            return this.DataBase.getEspecialidadById(Especialidad)
                .catch(e => console.log(e))
                .then(rows => {
                    if (!rows) return Promise.reject(new Error('No se encontro ' + Especialidad));
                    user.setEspecialidad(Especialidad);
                    return this.regularizeUser(user);
                });
        case 'SetCiclo':
            if (!user.getEspecialidad()) return this.regularizeUser(user);
            const Ciclo = parameters['ciclo'] || parameters;
            return this.DataBase.getCiclos()
                .then(rows => {
                    const ciclo = rows.filter(row => row['Nombre'] === Ciclo)[0];
                    if (!ciclo) return Promise.reject(new Error('No se encontro el ciclo ' + Ciclo));
                    const numero = parseInt(ciclo['Numero']);
                    user.setCiclo(numero);
                    return this.sendAvailableCourses(user);
                });
        case 'SetCurso':
            const course = parameters['curso'] || parameters;
            return this.DataBase.getCourseById(course)
                .then(curso => {
                    if (!curso) return Promise.reject(new Error('No se encontro curso ' + course));
                    const codigo = curso.getCodigo();
                    try {user.setCurso(codigo)}
                    catch (e) {
                        user.reset();
                        return Promise.reject(e);
                    }
                    return this.sendAvailableFolders(user);
                });
        case 'SetCarpeta':
            const folder = parameters['carpeta'] || parameters;
            try {user.setCarpeta(folder)}
            catch (e) {
                user.reset();
                return this.DataBase.logUserError(e, user, 'Usuario');
            }
            return this.sendAvailableFiles(user);
        case 'SetArchivo':
            const shortName = parameters['archivo'] || parameters;
            return this.detectFiles(user, shortName)
                .then(files => this.sendFiles(user, files));
        default:
            const e = new Error('Commando no valido, '+command);
            this.DataBase.logUserError(e, user, 'Bot')
                .catch(e => console.log(e));
            return Promise.reject(e);
    }
};
/**
 *
 * @param {Usuario} user
 * @param {String} petition
 * @param {String} text
 * @returns {Promise}
 */
Bot.prototype.executePetition = function (user, petition, text) {
    const userId = user.getFacebookId();
    switch (petition) {
        case 'Meme':
            const memeFolder = this.mediaFolder + '/memes';
            const cachedMemes = this.CacheHandler.get(memeFolder);
            return this.MessagingChannel.sendText(userId, text, false)
                .then(() => {
                    if (cachedMemes) return cachedMemes.random();
                    return this.FileStorage.listObjectsUnder(memeFolder);
                })
                .then(keys => {
                    keys = keys.filter(key => key.indexOf('.') !== -1);
                    this.CacheHandler.set(memeFolder, keys);
                    const meme = new Archivo(keys.random());
                    return this.FileStorage.getPublicURL(meme.getKey())
                      .then(url => {
                        return {
                          url : url,
                          type : meme.getType(),
                          attachment_id : ''
                        }
                      })
                })
                .catch(e => this.DataBase.logUserError(e, user, 'FileStorage'))
                .then(parameter => this.MessagingChannel.sendAttachment(userId, parameter))
                .catch(e => this.DataBase.logUserError(e, user, 'MessagingChannel'));

        default:
            const e = new Error('Peticion no valida, '+petition);
            this.DataBase.logUserError(e, user, 'Bot')
                .catch(e => console.log(e));
            return Promise.reject(e);
    }
};
/**
 *
 * @param {Usuario} user
 * @param {{text:String, payload:Object, parameters:Object}} intent
 * @returns {Promise}
 */
Bot.prototype.processPayloadFromNLP = function (user, intent) {
    const {text, payload, parameters} = intent;
    if (payload['comando']) {
        // Commands come with parameters that must be procesed
        const command = payload['comando'];
        return this.executeCommand(user, command, parameters);
    } else if (payload['peticion']) {
        // Petitions have no parameters
        const petition = payload['peticion'];
        return this.executePetition(user, petition, text);
    }
    const e = new Error("No method provided to process Payload: "+JSON.stringify(payload));
    this.DataBase.logUserError(e, user, 'NLPMotor')
        .catch(e => console.log(e));
    return Promise.reject(e);
};
/**
 *
 * @param {Usuario} user
 * @param {String} message
 * @returns {Promise}
 */
Bot.prototype.recieveMessage = async function (user, message) {
  const scapedMessage = RegExp.escape(message);
    if (!user.Valido) return Promise.reject(new Error('Usuario no valido.'));
    let userRequestedOnlyOneFolder = false;
    let userRequestedOnlyOneCourse = false;
    try {
        const courses = await this.detectCourses(user, scapedMessage);
        if (courses.length > 0) {
            if (courses.length > 1) return this.sendCourses(user, courses);
            else {
                user.setCurso(courses[0]['Codigo']);
                userRequestedOnlyOneCourse = true;
            }
        }
    } catch (e) {
        this.DataBase.logUserError(e, user, 'DataBase')
            .catch(e => console.log(e));
    }
    try {
        const folders = await this.detectFolders(user, scapedMessage);
        if (folders.length > 0) {
            if (folders.length > 1) return this.sendFolders(user, folders);
            else {
                user.setCarpeta(folders[0]);
                userRequestedOnlyOneFolder = true;
            }
        }
    } catch (e) {
        this.DataBase.logUserError(e, user, 'FileSystem')
            .catch(e => console.log(e));
    }
    try {
        const files = await this.detectFiles(user, scapedMessage);
        if (files.length > 0) return this.sendFiles(user, files);
    } catch (e) {
        this.DataBase.logUserError(e, user, 'FileSystem')
            .catch(e => console.log(e));
    }

    if (userRequestedOnlyOneFolder) {
        return this.sendAvailableFiles(user);
    } else if (userRequestedOnlyOneCourse) {
        return this.sendAvailableFolders(user);
    }

    
    const userId = user.getFacebookId();
    return this.NLPMotor.processText(userId, message)
        .then(intent => {
            const {text, payload} = intent;
            const payloadKeys = Object.getOwnPropertyNames(payload);
            if (payloadKeys.length > 0) return this.processPayloadFromNLP(user, intent);
            return this.MessagingChannel.sendTextWithURLs(userId, text, false)
        })
        .catch(e => {
            this.DataBase.logUserError(e, user, 'NLPMotor');
            const emergencyResponse = 'No puedo brindarte una respuesta fluida.';
            return this.MessagingChannel.sendText(userId, emergencyResponse, false);
        })
        .catch(e => this.DataBase.logInternalError(e, 'MessagingChannel'));
};
/**
 *
 * @param {Usuario} user
 * @param {String} payload
 * @returns {Promise}
 */
Bot.prototype.recievePayload = function (user, payload) {
    const data = payload.split(':');
    if (data.length > 2 || data.length === 0) return Promise.reject(new Error('Comando invalido'));
    const command = data[0];
    const arguments = data[1];
    return this.executeCommand(user, command, arguments);
};
/**
 *
 * @param {Usuario} user
 * @returns {Promise}
 */
Bot.prototype.endInteraction = function (user) {
    return this.DataBase.updateUser(user);
};
module.exports = Bot;