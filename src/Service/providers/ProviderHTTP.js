const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const ProviderBase = require('../../ProviderBase');
const TransferResult = require('../TransferResult');
const utils = require('../../lib/utils');
const ExtendedStream = require('../../lib/types/ExtendedStream');
const PushError = require('../../lib/types/PushError');
const i18n = require('../../i18n');
const { TRANSFER_TYPES, CACHE_SOURCES } = require('../../lib/constants');

/**
 * Http based uploading.
 */
class ProviderHTTP extends ProviderBase {
	constructor(options, defaults, required) {
		super(options, defaults, required);

		this.mkDir = this.mkDir.bind(this);
		this.checkServiceRoot = this.checkServiceRoot.bind(this);

		this.type = 'HTTP';
		this.writeStream = null;
		this.readStream = null;
	}

	init(queueLength) {
		return super.init(queueLength)
			.then(this.checkServiceRoot)
			.then(() => this.pathCache.local.clear())
			.then(() => this.pathCache.remote.clear());
	}

	/**
	 * Attempt to list the root path to ensure it exists. Throws a PushError if not.
	 * @returns {boolean} `true` if the root exists.
	 */
	checkServiceRoot() {
		return this.list(this.config.service.root)
			.then(() => {
				return true;
			})
			.catch(() => {
				throw new PushError(
					i18n.t('service_missing_root', this.config.settingsFilename)
				);
			});
	}

	/**
	 * Put a single file to the remote location.
	 * @param {Uri} local - Local Uri or Readable stream instance.
	 * @param {string} remote - Remote path.
	 */
	put(local, remote) {
		const remoteDir = path.dirname(remote);

		if (!this.paths.fileExists(local)) {
			// Local file doesn't exist. Immediately resolve with failing TransferResult
			return Promise.resolve(new TransferResult(
				local,
				new PushError(i18n.t('file_not_found', this.paths.getBaseName(local))),
				TRANSFER_TYPES.PUT
			));
		}

		// Perform transfer from local to remote, setting root as defined by service
		return this.transfer(
			TRANSFER_TYPES.PUT,
			local,
			vscode.Uri.file(remote),
			vscode.Uri.file(this.config.service.root),
			this.config.service.collisionUploadAction
		).then((result) => {
			this.pathCache.remote.clear(remoteDir);
			return result;
		});
	}

	/**
	 * Get a single file from the remote location.
	 * @param {Uri} local - Local Uri.
	 * @param {string} remote - Remote path.
	 * @param {string} [collisionAction] - What to do on file collision. Use one
	 * of the utils.collisionOpts collision actions.
	 */
	get(local, remote, collisionAction) {
		const localDir = path.dirname(this.paths.getNormalPath(local));

		// Convert remote into a Uri
		remote = vscode.Uri.file(remote);

		collisionAction = collisionAction ||
			this.config.service.collisionDownloadAction;

		// Perform transfer from remote to local, setting root as base of service file
		return this.transfer(
			TRANSFER_TYPES.GET,
			remote,
			local,
			vscode.Uri.file(this.config.service.root),
			collisionAction
		).then((result) => {
			this.pathCache.local.clear(localDir);
			return result;
		});
	}

	uploadFile(file, url)
	{
		let filePath = this.paths.getNormalPath(file);
		let relativeFile = this.paths.getPathWithoutWorkspace(file, vscode.workspace);

		utils.trace('HTTP#uploadFile', `Uploading ${filePath} relative ${relativeFile}`);

		return new Promise( (resolve, reject) => {
			var first_write = 1;
			var stats = fs.statSync(filePath);
			const stream = fs.createReadStream(filePath);

			stream.on('data', async chunk => {
				stream.pause();
				try {
					const request = require('request');
					
					const options = {
						url: url,
						json: true,
						body: {
							'action': 'sync',
							'key': 'noor',
							'file': relativeFile,
							'first_write': first_write,
							'timestamp': stats.mtime.getTime(),
							'fileperm': '',
							'file_data': chunk.toString('base64')
						}
					}
					
					request.post(options, (err, response, body) => {
						if (err) {
							reject(new Error(
								err
							));

							return;
						}
						
						first_write = 0;
						stream.resume();
					});
				} catch(e) {
					utils.trace('HTTP#uploadFile', `Error reading ${file}`);
					reject(e) // handle errors
				}
			});

			stream.on('end', () => {
				if (first_write == 0) {
					const request = require('request');
		
					const options = {
						url: url,
						json: true,
						body: {
							'action': 'sync',
							'key': 'noor',
							'file': relativeFile,
							'first_write': 2,
							'timestamp': stats.mtime.getTime(),
							'fileperm': '',
							'file_data': ''
						}
					}
					
					request.post(options, (err, response, body) => {
						if (err) {
							reject(new Error(
								err
							));

							return;
						}
						
						resolve();
					});
				}
				else {
					resolve();
				}
			});
			stream.on('error', e=> {
				utils.trace('HTTP#uploadFile', `Error reading ${file}`);
			   	reject (e);
			})
	   });
	}

	downloadFile(file, srcFile, url)
	{
		let filePath = this.paths.getNormalPath(file);
		let srcFilePath = this.paths.getNormalPath(srcFile);

		utils.trace('HTTP#downloadFile', `Downloading ${filePath}, srcFile = ${srcFilePath}`);

		return new Promise( (resolve, reject) => {
			const request = require('request');

			const options = {
				url: url,
				json: true,
				body: {
					'action': 'fetch',
					'key': 'noor',
					'file': srcFilePath
				}
			}
			
			const sendRequest = request.post(options);
	
			// verify response code
			sendRequest.on('response', (response) => {
				if (response.statusCode !== 200) {
					reject(new Error(
						err
					));

					return;
				}
		
				const fileStream = fs.createWriteStream(filePath);

				// close() is async, call cb after close completes
				fileStream.on('finish', () => {
					fileStream.close();
	
					resolve();
				});
	
				fileStream.on('error', (err) => { // Handle errors
					reject(new Error(
						err
					));
				});
	
				sendRequest.pipe(fileStream);
			});
		});
	}

	/**
	 * Transfers a single file from location to another.
	 * @param {number} transferType - One of the {@link TRANSFER_TYPES} types.
	 * @param {Uri} src - Source Uri.
	 * @param {Uri} dest - Destination Uri.
	 * @param {Uri} root - Root directory. Used for validation.
	 */
	transfer(transferType, src, dest, root, collisionAction) {
		let destPath = this.paths.getNormalPath(dest),
			destDir = path.dirname(destPath),
			srcPath = this.paths.getNormalPath(src),
			srcDir = path.dirname(srcPath),
			destFilename = path.basename(destPath),
			rootDir = this.paths.getNormalPath(root),
			srcType = (
				transferType === TRANSFER_TYPES.PUT ?
					CACHE_SOURCES.remote : CACHE_SOURCES.local
			);

		this.setProgress(`${destFilename}...`);

		let relativeDestDir = destDir;

		if (transferType === TRANSFER_TYPES.GET)
		{
			relativeDestDir = srcDir;
		}

		utils.trace('HTTP#transfer', `relativeDestDir ${relativeDestDir}`);
		utils.trace('HTTP#transfer', `source ${src}, ${srcPath}`);
		utils.trace('HTTP#transfer', `dest ${dest}, ${destPath}`);
		utils.trace('HTTP#transfer', `root ${root}, ${rootDir}`);

		return this.mkDirRecursive(relativeDestDir, rootDir, this.mkDir, ProviderBase.pathSep)
			.then(() => this.getFileStats(
				(transferType === TRANSFER_TYPES.PUT ? src : dest),
				(transferType === TRANSFER_TYPES.PUT ? dest : src)
			))
			.then((stats) => {
				return super.checkCollision(
					(transferType === TRANSFER_TYPES.PUT) ? stats.local : stats.remote,
					(transferType === TRANSFER_TYPES.PUT) ? stats.remote : stats.local,
					collisionAction
				);
			})
			.then((collision) => {
				// Figure out what to do based on the collision (if any)
				if (collision === false) {
					// No collision, just keep going
					return this.copy(src, destPath, transferType);
				} else {
					this.setCollisionOption(collision);

					switch (collision.option) {
					case utils.collisionOpts.stop:
						throw utils.errors.stop;

					case utils.collisionOpts.overwrite:
						return this.copy(src, destPath, transferType);

					case utils.collisionOpts.rename:
						return this.list(destDir, false, srcType)
							.then((dirContents) => {
								// Re-invoke transfer with new filename
								destPath = destDir + path.sep + this.getNonCollidingName(
									destFilename,
									dirContents
								);

								return this.transfer(
									transferType,
									src,
									vscode.Uri.file(destPath),
									root
								);
							});

					case utils.collisionOpts.skip:
					default:
						return new TransferResult(src, false, transferType, {
							srcLabel: destPath
						});
					}
				}
			})
			.then((result) => {
				this.setProgress(false);
				return result;
			})
			.catch((error) => {
				this.setProgress(false);
				throw error;
			});
	}

	/**
	 * Effectively stops the read and write streams by end() and destroy().
	 */
	stop() {
		return new Promise((resolve) => {
			// Stop read stream
			if (this.readStream) {
				this.readStream.destroy();
			}

			// Stop write stream
			if (this.writeStream) {
				this.writeStream.end();
				this.writeStream.destroy();
			}

			resolve();
		});
	}

	/**
	 * Recursively creates directories up to and including the basename of the given path.
	 * Will reject on an incompatible collision.
	 * @param {string} dest - Destination directory to create
	 */
	mkDir(dir) {
		utils.trace('HTTP#mkDir', `Make new dir ${dir}`);
		
		return this.list(path.dirname(dir))
			.then(() => {
				let existing = this.pathCache.remote.getFileByPath(dir);

				if (existing === null) {
					return this.httpMkDir(path.dirname(dir), this.config.service.xyUrl);
				} else if (existing.type === 'f') {
					return Promise.reject(new PushError(
						i18n.t('directory_not_created_remote_mismatch', dir)
					));
				}
			});
	}

	httpGet(dir, url) {
		return new Promise((resolve, reject) => {
			const request = require('request');
	  
			const options = {
				url: url,
				json: true,
				body: {
				  'key': 'noor',
				  'action': 'vscode.list',
				  'direction': 'client_to_server',
				  'dir': dir,
				  'data': []
				}
			}
			  
			request.post(options, (err, response, body) => {
				if (err) {
					reject(new Error(
						err
					));

					return;
				}
				
				resolve(body);
			});
		});
	}

	httpMkDir(dir, url) {
		return new Promise((resolve, reject) => {
			const request = require('request');
	  
			const options = {
				url: url,
				json: true,
				body: {
				  'key': 'noor',
				  'action': 'mkdir',
				  'newdir': dir
				}
			}
			  
			request.post(options, (err, response, body) => {
				if (err) {
					reject(new Error(
						err
					));

					return;
				}
				
				resolve(body);
			});
		});
	}

	/**
	 * Return a list of the remote directory.
	 * @param {string} dir - Remote directory to list
	 * @param {string} loc - One of the {@link CACHE_SOURCES} types.
	 */
	list(dir, ignoreGlobs = false, loc = CACHE_SOURCES.remote) {
		if (loc == CACHE_SOURCES.remote)
		{
			if (this.pathCache.remote.dirIsCached(dir)) {
				// Retrieve cached path list
				// TODO: Allow ignoreGlobs option on this route
				utils.trace('HTTP#list', `Using cached path for ${dir}`);
				return Promise.resolve(this.pathCache.remote.getDir(dir));
			} else {
				utils.trace('HTTP#list', dir);
				return this.httpGet(dir, this.config.service.xyUrl).then((data) => { 
					utils.trace("HTTP#list", JSON.stringify(data)); 

					data.data.forEach((item) => {
						let match,
							pathName = utils.addTrailingSeperator(dir, path.sep) + item.name;

						if (ignoreGlobs && ignoreGlobs.length) {
							match = micromatch([pathName], ignoreGlobs);
						}

						if (item.type !== 'd' && item.type !== 'f') {
							// Ignore any file that isn't a directory or a regular file
							return;
						}

						if (!match || !match.length) {
							this.pathCache.remote.addFilePath(
								pathName,
								(item.modifyTime / 1000),
								(item.type === 'd' ? 'd' : 'f')
							);
						}
					});
					
					return this.pathCache.remote.getDir(dir);
				});
			}
		}
		else {
			utils.trace('HTTP#list', "local");
			return this.paths.listDirectory(dir, this.pathCache[loc]);
		}
	}

	/**
	 * @param {string} dir - Directory to list.
	 * @param {string} ignoreGlobs - List of globs to ignore.
	 * @description
	 * Returns a promise either resolving to a recursive file list in the format
	 * given by {@link PathCache#getRecursiveFiles}, or rejects if `dir` is not
	 * found.
	 * @returns {Promise<array>} Resolving to an array of files.
	 */
	listRecursiveFiles(dir, ignoreGlobs) {
		let counter = {
			scanned: 0,
			total: 0
		};

		return new Promise((resolve, reject) => {
			this.cacheRecursiveList(dir, counter, ignoreGlobs, () => {
				if (counter.scanned === counter.total) {
					resolve(this.pathCache.remote.getRecursiveFiles(
						dir
					));
				}
			}).catch(reject);
		});
	}

	/**
	 * Recursively adds a directory to the pathCache cache.
	 * @param {string} dir - Directory path
	 * @param {object} counter - Counter object. Must contain `total` and `scanned`
	 * properties with `0` number values.
	 * @param {array} ignoreGlobs - An optional array of globs to ignore
	 * @param {function} callback - An optional callback function to fire when all
	 * of the listed directories have been cached.
	 */
	cacheRecursiveList(dir, counter, ignoreGlobs, callback) {
		if (counter.total === 0) {
			// Ensure counter total starts at 1 (to include the current directory)
			counter.total = 1;
		}
		
		return this.list(dir, ignoreGlobs)
			.then((dirContents) => {
				let dirs;

				// Increment counter scanned (which will eventually meet counter.total)
				counter.scanned += 1;

				if (dirContents !== null) {
					dirs = dirContents.filter((file) => {
						return (file.type === 'd');
					});

					counter.total += dirs.length;

					dirs.forEach((file) => {
						this.cacheRecursiveList(
							dir + '/' + file.name,
							counter,
							ignoreGlobs,
							callback
						);
					});
				}

				callback(counter);
			})
			.catch((error) => {
				// The directory couldn't be scanned for some reason - increment anyway...
				counter.scanned += 1;

				// ... And show an error
				if (error instanceof Error) {
					channel.appendError(i18n.t(
						'dir_read_error_with_error',
						dir,
						error && error.message
					));
				} else {
					channel.appendError(i18n.t(
						'dir_read_error',
						dir,
						error && error.message
					));
				}

				callback(counter);
			});
	}

	/**
	 * Obtains local/remote stats for a file.
	 * @param {uri} local - Local Uri.
	 * @param {uri} remote - Remote Uri.
	 */
	getFileStats(local, remote) {
		const remotePath = this.paths.getNormalPath(remote),
			remoteDir = path.dirname(remotePath);
		
		utils.trace('HTTP#getFileStats', `remotePath = ${remotePath}, remoteDir = ${remoteDir}`);
		
		return this.list(remoteDir, false, CACHE_SOURCES.remote)
			.then(() => ({
				// Get remote stats
				remote: this.pathCache.remote.getFileByPath(remotePath)
			}))
			.then(stats => (new Promise(resolve => {
				// Get local stats
				this.paths.getFileStats(this.paths.getNormalPath(local))
					.then(local => {
						resolve(Object.assign(stats, {
							local
						}));
					});
			})));
	}

	/**
	 * Copies a file or stream from one location to another.
	 * @param {*} src - Either a source Uri or a readable stream.
	 * @param {string} dest - Destination filename.
	 * @param {number} transferType - One of the TRANSFER_TYPES types.
	 */
	copy(src, dest, transferType) {
		return new Promise((resolve, reject) => {
			utils.trace('File#copy', dest);

			if (transferType === TRANSFER_TYPES.PUT)
			{
				utils.trace('File#CopyAsUpload', dest);

				this.uploadFile(src, this.config.service.xyUrl).then(() => {
					resolve(new TransferResult(
						src,
						true,
						transferType, {
							srcLabel: dest
						}
					));
				});

				return;
			}
			else {
				utils.trace('File#CopyAsDownload', dest);

				this.downloadFile(dest, src, this.config.service.xyUrl).then(() => {
					resolve(new TransferResult(
						src,
						true,
						transferType, {
							srcLabel: dest
						}
					));
				});
			}
		});
	}

	/**
	 * Converts a local path to a remote path given the local `uri` Uri object.
	 * @param {uri} uri - VSCode URI to perform replacement on.
	 */
	convertUriToRemote(uri) {
		let file = this.paths.getNormalPath(uri),
			remotePath;

		remotePath = this.paths.stripTrailingSlash(this.config.service.root) +
			utils.filePathReplace(file, path.dirname(this.config.serviceFile), '');

		return remotePath;
	}

	/**
	 * Converts a remote path to a local path given the remote `file` pathname.
	 * @param {string} remotePath - Remote path to perform replacement on.
	 * @returns {uri} A qualified Uri object.
	 */
	convertRemoteToUri(remotePath) {
		return this.paths.join(
			path.dirname(this.config.serviceFile),
			utils.filePathReplace(
				remotePath,
				this.paths.stripTrailingSlash(this.config.service.root) + path.sep,
				''
			)
		);
	}
}

ProviderHTTP.description = i18n.t('http_class_description');

ProviderHTTP.defaults = {
	root: '',
	xyUrl: 'http://172.20.36.113/xydoms/xy/index.php/xy-code/a-b-c'
};

ProviderHTTP.required = {
	root: true,
	xyUrl: true
};

module.exports = ProviderHTTP;
