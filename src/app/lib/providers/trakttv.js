(function(App) {
    'use strict';

    function TraktTv() {
        this.client = new Trakt({
            client_id: Settings.trakttv.client_id,
            client_secret: Settings.trakttv.client_secret,
            plugins: ['ondeck', 'matcher', 'images'],
            options: {
                images: {
                    smallerImages: true,
                    fanartApiKey: Settings.fanart.api_key,
                    tvdbApiKey: Settings.tvdb.api_key,
                    tmdbApiKey: Settings.tmdb.api_key
                }
            }
        });

        this.authenticated = false;

        // auto sign-in when database is loaded
        App.vent.on('db:ready', this.reAuthenticate.bind(this));
    }

    TraktTv.prototype = {
        cache: 1000 * 60 * 30, // 30min

        config: {
            name: 'Trakttv'
        },

        authenticate: function() {
            // called by setting_container.tpl button
            return this.client.get_codes().then(function(poll) {
                $('#authTraktCode input').val(poll.user_code); // settings_container.tpl code placeholder
                nw.Clipboard.get().set(poll.user_code); // copy code to clipboad
                nw.Shell.openExternal(poll.verification_url); // open remote URL

                return this.client.poll_access(poll); // wait for trakt response
            }.bind(this)).then(function(auth) {
                this.client.import_token(auth); // inject response
                AdvSettings.set('traktStatus', auth);
                this.onReady(true); // force the 1st sync
                return true;
            }.bind(this)).catch(function(err) {
                AdvSettings.set('traktStatus', false);
                win.error('Trakt: authentication failed', err);
                return err;
            });
        },

        reAuthenticate: function() {
            // used on event 'db:ready', to reload trakt client with auth
            if (Settings.traktStatus) {
                this.client.import_token(Settings.traktStatus).then(function(auth) {
                    AdvSettings.set('traktStatus', auth);
                    this.onReady();
                }.bind(this)).catch(function(err) {
                    win.error('Trakt: auto sign-in failed', err);
                    this.disconnect();
                }.bind(this));
            }
        },

        disconnect: function() {
            // reset everything to factory state
            Settings.traktStatus = false;
            AdvSettings.set('traktStatus', false);
            AdvSettings.set('traktLastSync', false);
            AdvSettings.set('traktLastActivities', false);
            this.authenticated = false;
        },

        syncMovies: function() {
            var watchedMovies = [];
            return this.client.sync.watched({
                type: 'movies'
            }).then(function(movies) {
                for (var m in movies) { // format for our db
                    var movie = movies[m].movie;
                    if (movie.ids.imdb) {
                        watchedMovies.push({
                            movie_id: movie.ids.imdb.toString(),
                            date: new Date(),
                            type: 'movie'
                        });
                    } else {
                        win.warn('Cannot sync a movie (' + movie.title + '), no IMDB id provided by Trakt');
                    }
                }
                win.debug('Trakt: marked %s movie(s) as watched', watchedMovies.length);
                return Database.markMoviesWatched(watchedMovies);
            }).catch(function(error) {
                win.warn('Trakt: unable to sync movies', error);
                return watchedMovies;
            });
        },

        syncEpisodes: function() {
            var watchedEpisodes = [];
            return this.client.sync.watched({
                type: 'shows'
            }).then(function(shows) {
                for (var d in shows) { // format for our db
                    var show = shows[d];
                    if (show.show.ids.imdb && show.show.ids.tvdb) {
                        for (var s in show.seasons) {
                            var season = show.seasons[s];
                            for (var e in season.episodes) {
                                watchedEpisodes.push({
                                    tvdb_id: show.show.ids.tvdb.toString(),
                                    imdb_id: show.show.ids.imdb.toString(),
                                    season: season.number.toString(),
                                    episode: season.episodes[e].number.toString(),
                                    date: new Date(),
                                    type: 'episode'
                                });
                            }
                        }
                    } else {
                        win.warn('Cannot sync a show (' + show.show.title + '), no IMDB/TVDB ids provided by Trakt');
                    }
                }

                win.debug('Trakt: marked %s episode(s) as watched', watchedEpisodes.length);
                return Database.markEpisodesWatched(watchedEpisodes);
            }).catch(function(error) {
                win.warn('Trakt: unable to sync shows', error);
                return watchedEpisodes;
            });
        },

        syncAll: function(watchlist) {
            Database.deleteWatched();

            return Promise.all([
                this.syncMovies(),
                this.syncEpisodes(),
                App.Providers.get('Watchlist').fetch({force: watchlist})
            ]).then(function() {
                AdvSettings.set('traktLastSync', Date.now());
                return true;
            }).catch(function(error) {
                win.error('Trakt: sync failed', error);
                return error;
            });
        },

        getPlayback: function(type, id) {
            // search for saved playback
            return this.client.sync.playback.get({
                type: type === 'movie' ? 'movies' : 'episodes',
                limit: 50
            }).then(function(results) {
                for (var r in results) {
                    var item = results[r];
                    var ids = item[item.type].ids;
                    if ([ids.imdb, ids.tvdb].indexOf(id) !== -1) {
                        return item.progress;
                    }
                }
                return 0;
            });
        },

        scrobble: function(action, type, id, progress) {
            var post = {progress: progress};
            var item = {ids: {}};
            var idType = type === 'movie' ? 'imdb' : 'tvdb';

            item.ids[idType] = id;
            post[type] = item;

            return this.client.scrobble[action](post);
        },

        onReady: function(forced) {
            this.authenticated = true;
            console.info('Trakt: authenticated');

            var refresh = Settings.traktLastSync + this.cache < Date.now();
            var onStart = Settings.traktSyncOnStart;

            if (forced) {
                // sync forced (usually first call or settings button)
                return this.syncAll(true);
            }

            if (onStart && refresh) {
                // cache is old, refresh if something has changed in last_activities
                this.client.sync.last_activities().then(function(activities) {
                    var lastActivities = activities.movies.watched_at > activities.episodes.watched_at ? activities.movies.watched_at : activities.episodes.watched_at;
                    if (lastActivities > Settings.traktLastActivities) {
                        // there is new activity, resync
                        AdvSettings.set('traktLastActivities', lastActivities);
                        this.syncAll();
                    } else {
                        AdvSettings.set('traktLastSync', Date.now());
                    }
                }.bind(this));
            }
        },

        wrapHistory: function(call, type, id) {
            // history add/remove
            var post = {};
            var item = {ids: {}};
            var idType = type === 'movies' ? 'imdb' : 'tvdb';

            item.id[idType] = id;
            post[type] = [item];

            return this.client.sync.history[call](post);
        }
    };

    function onWatched(item, channel) {
        if (channel === 'seen') {
            var type = item.episode_id ? 'episodes' : 'movies';
            var id = item.episode_id ? item.episode_id : item.imdb_id;
            App.Trakt.client.sync.wrapHistory('add', type, id);
        }
    }

    function onUnWatched(item, channel) {
        if (channel === 'seen') {
            var type = item.episode_id ? 'episodes' : 'movies';
            var id = item.episode_id ? item.episode_id : item.imdb_id;
            App.Trakt.client.sync.wrapHistory('remove', type, id);
        }
    }

    App.vent.on('show:watched', onWatched);
    App.vent.on('movie:watched', onWatched);
    App.vent.on('show:unwatched', onUnWatched);
    App.vent.on('movie:unwatched', onUnWatched);

    App.Providers.Trakttv = TraktTv;
    App.Providers.install(TraktTv);

})(window.App);
