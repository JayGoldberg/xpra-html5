/*
 * Copyright (c) 2013-2017 Antoine Martin <antoine@xpra.org>
 * Copyright (c) 2014 Joshua Higgins <josh@kxes.net>
 * Copyright (c) 2015-2016 Spikes, Inc.
 * Licensed under MPL 2.0
 *
 * xpra window
 *
 * Based on shape.js but no longer requires it
 *
 * requires:
 *   jQueryUI
 */

"use strict";

/**
 * This is the class representing a window we draw on the canvas.
 * It has a geometry, it may have borders and a top bar.
 * The contents of the window is an image, which gets updated
 * when we receive pixels from the server.
 */
function XpraWindow(client, canvas_state, wid, x, y, w, h, metadata, override_redirect, tray, client_properties, geometry_cb, mouse_move_cb, mouse_down_cb, mouse_up_cb, mouse_scroll_cb, set_focus_cb, window_closed_cb, scale) {
	// use me in jquery callbacks as we lose 'this'
	const me = this;
	// there might be more than one client
	this.client = client;
	this.log = function() { client.log.apply(client, arguments); };
	this.warn = function() { client.warn.apply(client, arguments); };
	this.error = function() { client.error.apply(client, arguments); };
	this.exc = function() { client.exc.apply(client, arguments); };
	this.debug = function() { client.debug.apply(client, arguments); };
	this.debug_categories = client.debug_categories;
	//keep reference both the internal canvas and screen drawn canvas:
	this.canvas = canvas_state;
	this.canvas_ctx = this.canvas.getContext('2d');
	this.canvas_ctx.imageSmoothingEnabled = false;
	this.offscreen_canvas = null;
	this.offscreen_canvas_ctx = null;
	this._init_2d_canvas();
	this.draw_canvas = this.offscreen_canvas;
	this.paint_queue = [];
	this.paint_pending = 0;

	//enclosing div in page DOM
	this.div = jQuery("#" + String(wid));

	//callbacks start null until we finish init:
	this.geometry_cb = null;
	this.mouse_move_cb = null;
	this.mouse_down_cb = null;
	this.mouse_up_cb = null;
	this.mouse_scroll_cb = null;
	this.window_closed_cb = null;

	//xpra specific attributes:
	this.wid = wid;
	this.metadata = {};
	this.override_redirect = override_redirect;
	this.tray = tray;
	this.has_alpha = false;
	this.client_properties = client_properties;

	//window attributes:
	this.title = null;
	this.windowtype = null;
	this.fullscreen = false;
	this.saved_geometry = null;
	this.minimized = false;
	this.maximized = false;
	this.focused = false;
	this.decorations = true;
	this.resizable = false;
	this.stacking_layer = 0;

	//these values represent the internal geometry
	//i.e. geometry as windows appear to the compositor
	this.x = x;
	this.y = y;
	this.w = w;
	this.h = h;

	// scaling for client display width override
	this.scale = scale;

	// get offsets
	this.leftoffset = parseInt(jQuery(this.div).css('border-left-width'), 10);
	this.rightoffset = parseInt(jQuery(this.div).css('border-right-width'), 10);
	this.topoffset = parseInt(jQuery(this.div).css('border-top-width'), 10);
	this.bottomoffset = parseInt(jQuery(this.div).css('border-bottom-width'), 10);

	// Hook up the events we want to receive:
	this.set_focus_cb = set_focus_cb || null;
	this.mouse_move_cb = mouse_move_cb || null;
	this.mouse_down_cb = mouse_down_cb || null;
	this.mouse_up_cb = mouse_up_cb || null;
	this.mouse_scroll_cb = mouse_scroll_cb || null;
	jQuery(this.canvas).mousedown(function (e) {
		me.on_mousedown(e);
	});
	jQuery(this.canvas).mouseup(function (e) {
		me.on_mouseup(e);
	});
	jQuery(this.canvas).mousemove(function (e) {
		me.on_mousemove(e);
	});

	this.geometry_cb = geometry_cb || null;
	this.window_closed_cb = window_closed_cb || null;

	// update metadata that is safe before window is drawn
	this.update_metadata(metadata, true);

	// create the decoration as part of the window, style is in CSS
	jQuery(this.div).addClass("window");
	if (this.windowtype) {
		jQuery(this.div).addClass("window-" + this.windowtype);
	}

	if (this.client.server_is_desktop || this.client.server_is_shadow) {
		jQuery(this.div).addClass("desktop");
		this.resizable = false;
	}
	else if(this.tray) {
		jQuery(this.div).addClass("tray");
	}
	else if(this.override_redirect) {
		jQuery(this.div).addClass("override-redirect");
	}
	else if((this.windowtype == "") || (this.windowtype == "NORMAL") || (this.windowtype == "DIALOG") || (this.windowtype == "UTILITY")) {
		this.resizable = true;
		jQuery(this.div).addClass("border");
		// add a title bar to this window if we need to
		// create header
		jQuery(this.div).prepend('<div id="head' + String(wid) + '" class="windowhead"> '+
				'<span class="windowicon"><img class="windowicon" id="windowicon' + String(wid) + '" /></span> '+
				'<span class="windowtitle" id="title' + String(wid) + '">' + this.title + '</span> '+
				'<span class="windowbuttons"> '+
				'<span id="minimize' + String(wid) + '"><img src="icons/minimize.png" /></span> '+
				'<span id="maximize' + String(wid) + '"><img src="icons/maximize.png" /></span> '+
				'<span id="close' + String(wid) + '"><img src="icons/close.png" /></span> '+
				'</span></div>');
		// make draggable
		if (this.scale!==1) {
			jQuery(this.div).draggable({ transform: true });
		}
		jQuery(this.div).draggable({ cancel: "canvas" });
		function root_window_click(ev) {
			//fake a click on the root window,
			//this helps some buggy Java applications close their popup menus
			client.do_window_mouse_click(ev, null, true);
			client.do_window_mouse_click(ev, null, false);
		}
		jQuery("#head"+String(this.wid)).click(root_window_click);
		jQuery(this.div).on("dragstart",function(ev,ui){
			client.do_window_mouse_click(ev, me, false);
			root_window_click(ev);
			client.mouse_grabbed = true;
			me.set_focus_cb(me);
		});
		jQuery(this.div).on("dragstop",function(ev,ui){
			client.mouse_grabbed = false;
			me.handle_moved(ui);
		});
		// Use transform if scaled
		// This disables helper highlight, so we
		// move the resizable borders in transform plugin
		if (this.scale!==1) {
			jQuery(this.div).resizable({ transform: true });
		}
		// attach resize handles
		jQuery(this.div).resizable({ containment: 'parent', helper: "ui-resizable-helper", "handles": "n, e, s, w, ne, se, sw, nw" });
		//jQuery(this.div).on("resize",jQuery.debounce(50, function(ev,ui) {
		//  	me.handle_resized(ui);
		//}));
		jQuery(this.div).on("resizestart",function(ev,ui){
			client.do_window_mouse_click(ev, me, false);
			client.mouse_grabbed = true;
		});
		jQuery(this.div).on("resizestop",function(ev,ui){
		  	me.handle_resized(ui);
		  	me.set_focus_cb(me);
			client.mouse_grabbed = false;
			//workaround for the window going blank,
			//just force a refresh:
			setTimeout(function() {
				me.client.request_refresh(me.wid);
			}, 200);
		});
		this.d_header = '#head' + String(wid);
		this.d_closebtn = '#close' + String(wid);
		this.d_maximizebtn = '#maximize' + String(wid);
		this.d_minimizebtn = '#minimize' + String(wid);
		if (this.resizable) {
			jQuery(this.d_header).dblclick(function() {
				me.toggle_maximized();
			});
			jQuery(this.d_closebtn).click(function() {
				window_closed_cb(me);
			});
			jQuery(this.d_maximizebtn).click(function() {
				me.toggle_maximized();
			});
			jQuery(this.d_minimizebtn).click(function() {
				me.toggle_minimized();
			});
		}
		else {
			jQuery(this.d_closebtn).hide();
			jQuery(this.d_maximizebtn).hide();
			jQuery('#windowlistitemmax' + String(wid)).hide();
			jQuery(this.d_minimizebtn).hide();
		}
		// adjust top offset
		this.topoffset = this.topoffset + parseInt(jQuery(this.d_header).css('height'), 10);
		// stop propagation if we're over the window:
		jQuery(this.div).mousedown(function (e) {
			e.stopPropagation();
		});
		//bug 2418: if we stop 'mouseup' propagation,
		//jQuery can't ungrab the window with Firefox
		//jQuery(this.div).mouseup(function (e) {
		//	e.stopPropagation();
		//});
		// assign callback to focus window if header is clicked.
		jQuery(this.d_header).click(function(e) {
			if (!me.minimized && $(e.target).parents('.windowbuttons').length === 0) {
				me.client._window_set_focus(me);
			}
		});
	}

	// create the spinner overlay div
	jQuery(this.div).prepend('<div id="spinner'+String(wid)+'" class="spinneroverlay"><div class="spinnermiddle"><div class="spinner"></div></div></div>');
	this.spinnerdiv = jQuery('#spinner'+String(wid));

	// listen for mouse wheel events on my window
	const div = document.getElementById(wid);
	function on_mousescroll(e) {
		me.on_mousescroll(e);
	}
	if (Utilities.isEventSupported("wheel")) {
		div.addEventListener('wheel',			on_mousescroll, false);
	}
	else if (Utilities.isEventSupported("mousewheel")) {
		div.addEventListener('mousewheel',		on_mousescroll, false);
	}
	else if (Utilities.isEventSupported("DOMMouseScroll")) {
		div.addEventListener('DOMMouseScroll',	on_mousescroll, false); // for Firefox
	}

	this.png_cursor_data = null;
	this.pointer_down = -1;
	this.pointer_last_x = 0;
	this.pointer_last_y = 0;
	if (window.PointerEvent) {
		this.canvas.addEventListener("pointerdown", function(ev) {
			me.debug("mouse", "pointerdown:", ev);
			if (ev.pointerType=="touch") {
				me.pointer_down = ev.pointerId;
				me.pointer_last_x = ev.offsetX;
				me.pointer_last_y = ev.offsetY;
			}
		});
		this.canvas.addEventListener("pointermove", function(ev) {
			me.debug("mouse", "pointermove:", ev);
			if (me.pointer_down==ev.pointerId) {
				const dx = ev.offsetX-me.pointer_last_x;
				const dy = ev.offsetY-me.pointer_last_y;
				me.pointer_last_x = ev.offsetX;
				me.pointer_last_y = ev.offsetY;
				const mult = 20.0*(window.devicePixelRatio || 1);
				ev.wheelDeltaX = Math.round(dx*mult);
				ev.wheelDeltaY = Math.round(dy*mult);
				on_mousescroll(ev);
			}
		});
		this.canvas.addEventListener("pointerup", function(ev) {
			me.debug("mouse", "pointerup:", ev);
			me.pointer_down = -1;
		});
		this.canvas.addEventListener("pointercancel", function(ev) {
			me.debug("mouse", "pointercancel:", ev);
			me.pointer_down = -1;
		});
		this.canvas.addEventListener("pointerout", function(ev) {
			me.debug("mouse", "pointerout:", ev);
		});
	}

	// adapt to screen size if needed (ie: shadow / desktop windows):
	this.screen_resized();
	// set the CSS geometry
	this.updateCSSGeometry();
	// now read all metadata
	this.update_metadata(metadata);
}

XpraWindow.prototype._init_2d_canvas = function() {
	this.offscreen_canvas = document.createElement("canvas");
	this.updateCanvasGeometry();
	this.offscreen_canvas_ctx = this.offscreen_canvas.getContext('2d');
	this.offscreen_canvas_ctx.imageSmoothingEnabled = false;
};

XpraWindow.prototype.swap_buffers = function() {
	//the up to date canvas is what we'll draw on screen:
	this.debug("draw", "swap_buffers");
	this.draw_canvas = this.offscreen_canvas;
	this._init_2d_canvas();
	this.offscreen_canvas_ctx.drawImage(this.draw_canvas, 0, 0);
};

XpraWindow.prototype.set_spinner = function(state) {
	if(state) {
		this.spinnerdiv.hide();
	} else {
		this.spinnerdiv.css("display", "table");
	}
};

XpraWindow.prototype.ensure_visible = function() {
	if (this.client.server_is_desktop || this.client.server_is_shadow) {
		//those windows should usually be centered on screen,
		//moving them would mess that up
		return true;
	}
	if (this.override_redirect) {
		//OR windows cannot be moved server-side
		return true;
	}
	const oldx = this.x;
	const oldy = this.y;
	// for now make sure we don't out of top left
	// this will be much smarter!
	const min_visible = 80;
	const desktop_size = this.client._get_desktop_size();
	const ww = desktop_size[0];
	const wh = desktop_size[1];
	//this.log("x=", this.x, "y=", this.y, "w=", this.w, "h=", this.h, "leftoffset=", this.leftoffset, "topoffset=", this.topoffset, " - ww=", ww, "wh=", wh);
	if(oldx<this.leftoffset && oldx + this.w <= min_visible) {
		this.x = min_visible - this.w + this.leftoffset;
	}
	else if (oldx >= ww - min_visible) {
		this.x = Math.min(oldx, ww - min_visible);
	}
	if(oldy<=this.topoffset && oldy <= min_visible) {
		this.y = parseInt(this.topoffset);
	}
	else if (oldy >= wh - min_visible) {
		this.y = Math.min(oldy, wh - min_visible);
	}
	this.debug("geometry", "ensure_visible() oldx=", oldx, "oldy=", oldy, "x=", this.x, "y=", this.y);
	if((oldx != this.x) || (oldy != this.y)) {
		this.updateCSSGeometry();
		return false;
	}
	return true;
};

XpraWindow.prototype.updateCanvasGeometry = function() {
	// set size of both canvas if needed
	if(this.canvas.width != this.w) {
		this.canvas.width = this.w;
	}
	if(this.canvas.height != this.h) {
		this.canvas.height = this.h;
	}
	if(this.offscreen_canvas.width != this.w) {
		this.offscreen_canvas.width = this.w;
	}
	if(this.offscreen_canvas.height != this.h) {
		this.offscreen_canvas.height = this.h;
	}
};

XpraWindow.prototype.updateCSSGeometry = function() {
	// set size of canvas
	this.updateCanvasGeometry();
	if (this.client.server_is_desktop || this.client.server_is_shadow) {
		jQuery(this.div).position({of : jQuery("#screen")});
		return;
	}
	// work out outer size
	this.outerH = this.h + this.topoffset + this.bottomoffset;
	this.outerW = this.w + this.leftoffset + this.rightoffset;
	// set width and height
	jQuery(this.div).css('width', this.outerW);
	jQuery(this.div).css('height', this.outerH);
	// set CSS attributes to outerX and outerY
	this.outerX = this.x - this.leftoffset;
	this.outerY = this.y - this.topoffset;
	jQuery(this.div).css('left', this.outerX);
	jQuery(this.div).css('top', this.outerY);
	this.debug("geometry", "updateCSSGeometry() left=", this.outerX, ", top=", this.outerY, ", width=", this.outerW, ", height=", this.outerH);
};

XpraWindow.prototype.updateFocus = function() {
	if(this.focused) {
		// set focused style to div
		jQuery(this.div).addClass("windowinfocus");

	} else {
		// set not in focus style
		jQuery(this.div).removeClass("windowinfocus");
	}
};

/**
 * Mouse: delegate to client, telling it which window triggered the event.
 */
XpraWindow.prototype.on_mousemove = function(e) {
	this.mouse_move_cb(this.client, e, this);
	e.preventDefault();
	return false;
};

XpraWindow.prototype.on_mousedown = function(e) {
	this.mouse_down_cb(this.client, e, this);
	e.preventDefault();
	return false;
};

XpraWindow.prototype.on_mouseup = function(e) {
	this.mouse_up_cb(this.client, e, this);
	e.preventDefault();
	return false;
};

XpraWindow.prototype.on_mousescroll = function(e) {
	this.mouse_scroll_cb(this.client, e, this);
	//e.preventDefault();
	return false;
};

/**
 * toString allows us to identify windows by their unique window id.
 */
XpraWindow.prototype.toString = function() {
	return "Window("+this.wid+")";
};


XpraWindow.prototype.update_zindex = function() {
	let z = 5000 + this.stacking_layer;
	if (this.tray) {
		z = 0;
	}
	else if (this.override_redirect || this.client.server_is_desktop || this.client.server_is_shadow) {
		z = 30000;
	}
	else if (this.windowtype=="DROPDOWN" || this.windowtype=="TOOLTIP" ||
			this.windowtype=="POPUP_MENU" || this.windowtype=="MENU" ||
			this.windowtype=="COMBO") {
		z = 20000;
	}
	else if (this.windowtype=="UTILITY" || this.windowtype=="DIALOG") {
		z = 15000;
	}
	const above = this.metadata["above"];
	if (above) {
		z += 5000;
	}
	else {
		const below = this.metadata["below"];
		if (below) {
			z -= 5000;
		}
	}
	if (this.focused) {
		z += 2500;
	}
	jQuery(this.div).css('z-index', z);
};


/**
 * Update our metadata cache with new key-values,
 * then call set_metadata with these new key-values.
 */
XpraWindow.prototype.update_metadata = function(metadata, safe) {
	//update our metadata cache with new key-values:
	this.debug("main", "update_metadata(", metadata, ")");
	for (let attrname in metadata) {
		this.metadata[attrname] = metadata[attrname];
	}
	if(safe) {
		this.set_metadata_safe(metadata);
	} else {
		this.set_metadata(metadata);
	}
	this.update_zindex();
};

/**
 * Apply only metadata settings that are safe before window is drawn
 */
XpraWindow.prototype.set_metadata_safe = function(metadata) {
	if ("title" in metadata) {
		let title = Utilities.s(metadata["title"]);
		if (this.client.packet_encoder!="rencodeplus") {
			try {
				title = decodeURIComponent(escape(title));
			}
			catch (e) {
				this.log("unable to decode title string '"+title+"' received from ", this.client.protocol.packet_encoder, ": "+e);
			}
		}
		if (this.title!=title) {
			this.title = title;
			this.log("title=", this.title)
			jQuery('#title' + this.wid).html(this.title);
			const trimmedTitle = Utilities.trimString(this.title, 30);
			jQuery('#windowlistitemtitle'+this.wid).text(trimmedTitle);
		}
	}
	if ("has-alpha" in metadata) {
		this.has_alpha = metadata["has-alpha"];
	}
	if ("window-type" in metadata) {
		this.windowtype = Utilities.s(metadata["window-type"][0]);
	}
	if ("decorations" in metadata) {
		this.decorations = metadata["decorations"];
		this._set_decorated(this.decorations);
		this.updateCSSGeometry();
		this.handle_resized();
		this.apply_size_constraints();
	}
	if ("opacity" in metadata) {
		let opacity = metadata["opacity"];
		if (opacity<0) {
			opacity = 1.0;
		}
		else {
			opacity = opacity / 0x100000000;
		}
		jQuery(this.div).css('opacity', ''+opacity);
	}
	if ("iconic" in metadata) {
		this.set_minimized(metadata["iconic"]==1);
	}
	
	//if the attribute is set, add the corresponding css class:
	const attrs = ["modal", "above", "below"];
	for (let i = 0; i < attrs.length; i++) {
		const attr = attrs[i];
		if (attr in metadata) {
			const value = metadata[attr];
			if (value) {
				jQuery(this.div).addClass(attr);
			}
			else {
				jQuery(this.div).removeClass(attr);
			}
		}
	}
	if (this.resizable && "size-constraints" in metadata) {
		this.apply_size_constraints();
	}
	if ("class-instance" in metadata) {
		const wm_class = metadata["class-instance"];
		const classes = jQuery(this.div).prop("classList");
		if (classes) {
			//remove any existing "wmclass-" classes not in the new wm_class list:
			for (let i = 0; i < classes.length; i++) {
				const tclass = ""+classes[i];
				if (tclass.indexOf("wmclass-")===0 && wm_class && !wm_class.includes(tclass)) {
					jQuery(this.div).removeClass(tclass);
				}
			}
		}
		if (wm_class) {
			//add new wm-class:
			for (let i = 0; i < wm_class.length; i++) {
				const tclass = Utilities.s(wm_class[i]).replace(/[^0-9a-zA-Z]/g, '');
				if (tclass && !jQuery(this.div).hasClass(tclass)) {
					jQuery(this.div).addClass("wmclass-"+tclass);
				}
			}
		}
	}
};

XpraWindow.prototype.apply_size_constraints = function() {
	if (!this.resizable) {
		return;
	}
	if (this.maximized) {
		jQuery(this.div).draggable('disable');
	}
	else {
		jQuery(this.div).draggable('enable');
	}
	let hdec = 0;
	const wdec = 0;
	if (this.decorations) {
		//adjust for header
		hdec = jQuery('#head' + this.wid).outerHeight(true);
	}
	let min_size = null, max_size = null;
	const size_constraints = this.metadata["size-constraints"];
	if (size_constraints) {
		min_size = size_constraints["minimum-size"];
		max_size = size_constraints["maximum-size"];
	}
	let minw=null, minh=null;
	if (min_size) {
		minw = min_size[0]+wdec;
		minh = min_size[1]+hdec;
	}
	let maxw=null, maxh=null;
	if (max_size) {
		maxw = max_size[0]+wdec;
		maxh = max_size[1]+hdec;
	}
	if(minw>0 && minw==maxw && minh>0 && minh==maxh) {
		jQuery(this.d_maximizebtn).hide();
		jQuery('#windowlistitemmax' + String(this.wid)).hide();
		jQuery(this.div).resizable('disable');
	} else {
		jQuery(this.d_maximizebtn).show();
		if (!this.maximized) {
			jQuery(this.div).resizable('enable');
		}
		else {
			jQuery(this.div).resizable('disable');
		}
	}
	if (!this.maximized) {
		jQuery(this.div).resizable("option", "minWidth", minw);
		jQuery(this.div).resizable("option", "minHeight", minh);
		jQuery(this.div).resizable("option", "maxWidth", maxw);
		jQuery(this.div).resizable("option", "maxHeight", maxh);
	}
	//TODO: aspectRatio, grid
};


/**
 * Apply new metadata settings.
 */
XpraWindow.prototype.set_metadata = function(metadata) {
	this.set_metadata_safe(metadata);
	if ("fullscreen" in metadata) {
		this.set_fullscreen(metadata["fullscreen"]==1);
	}
	if ("maximized" in metadata) {
		this.set_maximized(metadata["maximized"]==1);
	}
};

/**
 * Save the window geometry so we can restore it later
 * (ie: when un-maximizing or un-fullscreening)
 */
XpraWindow.prototype.save_geometry = function() {
	this.saved_geometry = {
			"x" : this.x,
			"y"	: this.y,
			"w"	: this.w,
			"h" : this.h};
	this.debug("geometry", "save_geometry() saved-geometry=", this.saved_geometry);
};
/**
 * Restores the saved geometry (if it exists).
 */
XpraWindow.prototype.restore_geometry = function() {
	if (this.saved_geometry==null) {
		return;
	}
	this.x = this.saved_geometry["x"];
	this.y = this.saved_geometry["y"];
	this.w = this.saved_geometry["w"];
	this.h = this.saved_geometry["h"];
	this.debug("geometry", "restore_geometry() saved-geometry=", this.saved_geometry);
	// delete saved geometry
	this.saved_geometry = null;
	// then call local resized callback
	this.handle_resized();
	this.set_focus_cb(this);
};

/**
 * Maximize / unmaximizes the window.
 */
XpraWindow.prototype.set_maximized = function(maximized) {
	if(jQuery(this.div).is(":hidden")){
		jQuery(this.div).show();
	}

	if (this.maximized==maximized) {
		return;
	}
	this.max_save_restore(maximized);
	this.maximized = maximized;
	this.handle_resized();
	this.set_focus_cb(this);
	// this will take care of disabling the "draggable" code:
	this.apply_size_constraints();
};

/**
 * Toggle maximized state
 */
XpraWindow.prototype.toggle_maximized = function() {
	this.set_maximized(!this.maximized);
};

/**
 * Minimizes / unminimizes the window.
 */
XpraWindow.prototype.set_minimized = function(minimized) {
	if (this.minimized==minimized) {
		return;
	}
	this.minimized = minimized;
	if (minimized) {
		jQuery(this.div).hide(200);
	}
	else {
		jQuery(this.div).show(200);
	}
};


/**
 * Toggle minimized state
 */
XpraWindow.prototype.toggle_minimized = function() {
	//console.error("toggle_minimized minimized=", this.minimized);
	//get the geometry before modifying the window:
	const geom = this.get_internal_geometry();
	this.set_minimized(!this.minimized);
	if (this.minimized) {
		this.client.send(["unmap-window", this.wid, true]);
		this.stacking_layer = 0;
		if (this.client.focus==this.wid) {
			this.client.auto_focus();
		}
	}
	else {
		this.client.send(["map-window", this.wid, geom.x, geom.y, geom.w, geom.h, this.client_properties]);
		//force focus switch:
		this.client.focus = -1;
		this.client._window_set_focus(this);
	}
};

/**
 * Fullscreen / unfullscreen the window.
 */
XpraWindow.prototype.set_fullscreen = function(fullscreen) {
	//the browser itself:
	//we can't bring attention to the fullscreen widget, ie:
	//$("#fullscreen").fadeIn(100).fadeOut(100).fadeIn(100).fadeOut(100).fadeIn(100);
	//because the window is about to cover the top bar...
	//so just fullscreen the window:
	if (this.fullscreen==fullscreen) {
		return;
	}
	if (this.resizable) {
		if (fullscreen) {
			this._set_decorated(false);
		}
		else {
			this._set_decorated(this.decorations);
		}
	}
	this.max_save_restore(fullscreen);
	this.fullscreen = fullscreen;
	this.updateCSSGeometry();
	this.handle_resized();
	this.set_focus_cb(this);
};


XpraWindow.prototype._set_decorated = function(decorated) {
	this.topoffset = parseInt(jQuery(this.div).css('border-top-width'), 10);
	if (decorated) {
		jQuery('#head' + this.wid).show();
		jQuery(this.div).removeClass("undecorated");
		jQuery(this.div).addClass("window");
		if (this.d_header) {
			this.topoffset = this.topoffset + parseInt(jQuery(this.d_header).css('height'), 10);
			this.debug("geometry", "_set_decorated(", decorated, ") new topoffset=", self.topoffset);
		}
	}
	else {
		jQuery('#head' + this.wid).hide();
		jQuery(this.div).removeClass("window");
		jQuery(this.div).addClass("undecorated");
	}
};

/**
 * Either:
 * - save the geometry and use all the space
 * - or restore the geometry
 */
XpraWindow.prototype.max_save_restore = function(use_all_space) {
	if (use_all_space) {
		this.save_geometry();
		this.fill_screen();
	}
	else {
		this.restore_geometry();
	}
};

/**
 * Use up all the available screen space
 */
XpraWindow.prototype.fill_screen = function() {
	// should be as simple as this
	// in future we may have a taskbar for minimized windows
	// which should be subtracted from screen size
	const screen_size = this.client._get_desktop_size();
	this.x = this.leftoffset;
	this.y = this.topoffset;
	this.w = (screen_size[0] - this.leftoffset) - this.rightoffset;
	this.h = (screen_size[1] - this.topoffset) - this.bottomoffset;
	this.debug("geometry", "fill_screen() ", this.x, this.y, this.w, this.h);
};


/**
 * We have resized the window, so we need to:
 * - work out new position of internal canvas
 * - update external CSS position
 * - resize the backing image
 * - fire the geometry_cb
 */
XpraWindow.prototype.handle_resized = function(e) {
	// this function is called on local resize only,
	// remote resize will call this.resize()
	// need to update the internal geometry
	this.debug("geometry", "handle_resized(", e, ")");
	if(e) {
		this.x = this.x + Math.round(e.position.left - e.originalPosition.left);
		this.y = this.y + Math.round(e.position.top - e.originalPosition.top);
		this.w = Math.round(e.size.width) - this.leftoffset - this.rightoffset;
		this.h = Math.round(e.size.height) - this.topoffset - this.bottomoffset;
	}
	// then update CSS and redraw backing
	this.updateCSSGeometry();
	// send geometry callback
	this.geometry_cb(this);
};

/**
 * Like handle_resized, except we should
 * store internal geometry, external is always in CSS left and top
 */
XpraWindow.prototype.handle_moved = function(e) {
	const left = Math.round(e.position.left),
		top = Math.round(e.position.top);
	this.debug("geometry", "handle_moved(", e, ") left=", left, ", top=", top);
	// add on padding to the event position so that
	// it reflects the internal geometry of the canvas
	//this.log("handle moved: position=", e.position.left, e.position.top);
	this.x = left + this.leftoffset;
	this.y = top + this.topoffset;
	// make sure we are visible after move
	this.ensure_visible();
	// tell remote we have moved window
	this.geometry_cb(this);
};

/**
 * The "screen" has been resized, we may need to resize our window to match
 * if it is fullscreen or maximized.
 */
XpraWindow.prototype.screen_resized = function() {
	this.debug("geometry", "screen_resized() server_is_desktop=", this.client.server_is_desktop, ", server_is_shadow=", this.client.server_is_shadow);
	if (this.client.server_is_desktop) {
		this.match_screen_size();
	}
	if (this.client.server_is_shadow) {
		//note: when this window is created,
		// it may not have been added to the client's list yet
		const ids = Object.keys(this.client.id_to_window);
		if (ids.length==0 || ids[0]==this.wid) {
			//single window, recenter it:
			this.recenter();
		}
	}
	if (this.fullscreen || this.maximized) {
		this.fill_screen();
		this.handle_resized();
	}
	if (!this.ensure_visible()) {
		this.geometry_cb(this);
	}
};

XpraWindow.prototype.recenter = function(force_update_geometry) {
	let x = this.x,
		y = this.y;
	this.debug("geometry", "recenter() x=", x, ", y=", y, ", desktop size: ", this.client.desktop_width, this.client.desktop_height);
	x = Math.round((this.client.desktop_width-this.w)/2);
	y = Math.round((this.client.desktop_height-this.h)/2);
	if (this.x!=x || this.y!=y || force_update_geometry) {
		this.debug("geometry", "window re-centered to:", x, y);
		this.x = x;
		this.y = y;
		this.updateCSSGeometry();
		this.geometry_cb(this);
	}
	else {
		this.debug("geometry", "recenter() unchanged at ", x, y);
	}
	if (this.x<0 || this.y<0) {
		this.warn("window does not fit in canvas, offsets: ", x, y);
	}
};


XpraWindow.prototype.match_screen_size = function() {
	const maxw = this.client.desktop_width;
	const maxh = this.client.desktop_height;
	let neww = 0, newh = 0;
	if (this.client.server_resize_exact) {
		neww = maxw;
		newh = maxh;
		this.log("resizing to exact size:", neww, newh);
	}
	else {
		if (this.client.server_screen_sizes.length==0) {
			this.recenter();
			return;
		}
		//try to find the best screen size to use,
		//cannot be larger than the browser area
		let best = 0;
		let w = 0, h = 0;
		const screen_sizes = this.client.server_screen_sizes;
		let screen_size;
		for (let i = 0; i < screen_sizes.length; i++) {
			screen_size = screen_sizes[i];
			w = screen_size[0];
			h = screen_size[1];
			if (w<=maxw && h<=maxh && w*h>best) {
				best = w*h;
				neww = w;
				newh = h;
			}
		}
		if (neww==0 && newh==0) {
			//not found, try to find the smallest one:
			best = 0;
			for (let i = 0; i < screen_sizes.length; i++) {
				screen_size = screen_sizes[i];
				w = screen_size[0];
				h = screen_size[1];
				if (best==0 || w*h<best) {
					best = w*h;
					neww = w;
					newh = h;
				}
			}
		}
		this.log("best screen size:", neww, newh);
	}
	this.w = neww;
	this.h = newh;
	this.recenter(true);
};


/**
 * Things ported from original shape
 */

XpraWindow.prototype.move_resize = function(x, y, w, h) {
	this.debug("geometry", "move_resize(", x, y, w, h, ")");
	// only do it if actually changed!
	if (this.w != w || this.h != h || this.x != x || this.y != y) {
		this.w = w;
		this.h = h;
		this.x = x;
		this.y = y;
		if(!this.ensure_visible()) {
			// we had to move the window so that it was visible
			// is this the right thing to do?
			this.geometry_cb(this);
		}
		else {
			this.updateCSSGeometry();
		}
	}
};

XpraWindow.prototype.move = function(x, y) {
	this.debug("geometry", "move(", x, y, ")");
	this.move_resize(x, y, this.w, this.h);
};

XpraWindow.prototype.resize = function(w, h) {
	this.debug("geometry", "resize(", w, h, ")");
	this.move_resize(this.x, this.y, w, h);
};

XpraWindow.prototype.initiate_moveresize = function(mousedown_event, x_root, y_root, direction, button, source_indication) {
	const dir_str = MOVERESIZE_DIRECTION_STRING[direction];
	this.log("initiate_moveresize", dir_str, [x_root, y_root, direction, button, source_indication]);
	if (direction==MOVERESIZE_MOVE && mousedown_event) {
		const e = mousedown_event;
		e.type = "mousedown.draggable";
		e.target = this.div[0];
		this.div.trigger(e);
		//jQuery(this.div).trigger("mousedown");
	}
	else if (direction==MOVERESIZE_CANCEL) {
		jQuery(this.div).draggable('disable');
		jQuery(this.div).draggable('enable');
	}
	else if (direction in MOVERESIZE_DIRECTION_JS_NAME) {
		const js_dir = MOVERESIZE_DIRECTION_JS_NAME[direction];
		const resize_widget = jQuery(this.div).find(".ui-resizable-handle.ui-resizable-"+js_dir).first();
		if (resize_widget) {
			const pageX = resize_widget.offset().left;
			const pageY = resize_widget.offset().top;
			resize_widget.trigger("mouseover");
			resize_widget.trigger({ type: "mousedown", which: 1, pageX: pageX, pageY: pageY });
		}
	}
};


/**
 * Returns the geometry of the window backing image,
 * the inner window geometry (without any borders or top bar).
 */
XpraWindow.prototype.get_internal_geometry = function() {
	/* we store the internal geometry only
	 * and work out external geometry on the fly whilst
	 * updating CSS
	 */
	return { x : this.x,
			 y : this.y,
			 w : this.w,
			 h : this.h};
};

/**
 * Handle mouse click from this window's canvas,
 * then we fire "mouse_click_cb" (if it is set).
 */
XpraWindow.prototype.handle_mouse_click = function(button, pressed, mx, my, modifiers, buttons) {
	this.debug("mouse", "got mouse click at ", mx, my);
	// mouse click event is from canvas just for this window so no need to check
	// internal geometry anymore
	this.mouse_click_cb(this, button, pressed, mx, my, modifiers, buttons);
};


XpraWindow.prototype.update_icon = function(width, height, encoding, img_data) {
	let src = "favicon.png";
	if (encoding=="png") {
		//move title to the right:
		$("#title"+ String(this.wid)).css('left', 32);
		if (typeof img_data === 'string') {
			const uint = new Uint8Array(img_data.length);
			for(let i=0;i<img_data.length;++i) {
				uint[i] = img_data.charCodeAt(i);
			}
			img_data = uint;
		}
		src = "data:image/"+encoding+";base64," + Utilities.ArrayBufferToBase64(img_data);
	}
	jQuery('#windowicon' + String(this.wid)).attr('src', src);
	jQuery('#windowlistitemicon' + String(this.wid)).attr('src', src);
	return src;
};


XpraWindow.prototype.reset_cursor = function() {
	jQuery("#"+String(this.wid)).css("cursor", 'default');
	this.png_cursor_data = null;
};

XpraWindow.prototype.set_cursor = function(encoding, w, h, xhot, yhot, img_data) {
	if (encoding!="png") {
		this.warn("received an invalid cursor encoding:", encoding);
		return;
	}
	this.png_cursor_data = [w, h, xhot, yhot, img_data];
	let array = img_data;
	if ((typeof img_data) === 'string') {
		array = Utilities.StringToUint8(img_data);
	}
	const b64 = Utilities.ArrayBufferToBase64(array);
	const window_element = jQuery("#"+String(this.wid));
	const cursor_url = "data:image/" + encoding + ";base64," + b64;
	//j.src = "data:image/"+coding+";base64," + Utilities.ArrayBufferToBase64(img_data);
	function set_cursor_url(url, x, y) {
		const url_str = "url('"+url+"')";
		window_element.css("cursor", url_str+", default");
		//CSS3 with hotspot:
		window_element.css("cursor", url_str+" "+x+" "+y+", auto");
	}
	let zoom = detectZoom.zoom();
	//prefer fractional zoom values if possible:
	if (Math.round(zoom*4)==(2*Math.round(zoom*2))){
		zoom = Math.round(zoom*2)/2;
	}
	if (zoom!=1 && !Utilities.isMacOS()) {
		//scale it:
		const tmp_img = new Image();
		tmp_img.onload = function() {
			const canvas = document.createElement('canvas');
			const ctx = canvas.getContext('2d');
			ctx.imageSmoothingEnabled = false;
			canvas.width = Math.round(w*window.devicePixelRatio);
			canvas.height = Math.round(h*window.devicePixelRatio);
			ctx.drawImage(this, 0, 0, canvas.width, canvas.height);
			var scaled_cursor_url = canvas.toDataURL();
			set_cursor_url(scaled_cursor_url, Math.round(xhot*window.devicePixelRatio), Math.round(yhot*window.devicePixelRatio));
		};
		tmp_img.src = cursor_url;
	}
	else {
		set_cursor_url(cursor_url, xhot, yhot);
	}
};


XpraWindow.prototype.eos = function() {
	this._close_jsmpeg();
	this._close_broadway();
	this._close_video();
};


/**
 * This function draws the contents of the off-screen canvas to the visible
 * canvas. However the drawing is requested by requestAnimationFrame which allows
 * the browser to group screen redraws together, and automatically adjusts the
 * framerate e.g if the browser window/tab is not visible.
 */
XpraWindow.prototype.draw = function() {
	//pass the 'buffer' canvas directly to visible canvas context
	if (this.has_alpha || this.tray) {
		this.canvas_ctx.clearRect(0, 0, this.draw_canvas.width, this.draw_canvas.height);
	}
	this.canvas_ctx.drawImage(this.draw_canvas, 0, 0);
};


/**
 * The following function inits the Broadway h264 decoder
 */
XpraWindow.prototype._init_broadway = function(enc_width, enc_height, width, height) {
	const me = this;
	this.broadway_decoder = new Decoder({
		"rgb": 	true,
		"size": { "width" : enc_width, "height" : enc_height },
	});
	this.log("broadway decoder initialized");
	this.broadway_paint_location = [0, 0];
	this.broadway_decoder.onPictureDecoded = function(buffer, p_width, p_height, infos) {
		me._broadway_paint(buffer, enc_width, enc_height, width, height, p_width, p_height, infos);
	};
};

XpraWindow.prototype._broadway_paint = function(buffer, enc_width, enc_height, width, height, p_width, p_height, infos) {
	this.debug("draw", "broadway picture decoded: ", buffer.length, "bytes, size ", p_width, "x", p_height+", paint location: ", this.broadway_paint_location,"with infos=", infos);
	if(!this.broadway_decoder) {
		return;
	}
	const img = this.offscreen_canvas_ctx.createImageData(p_width, p_height);
	img.data.set(buffer);
	const x = this.broadway_paint_location[0];
	const y = this.broadway_paint_location[1];
	this.offscreen_canvas_ctx.putImageData(img, x, y, 0, 0, enc_width, enc_height);
	if(enc_width!=width || enc_height!=height) {
		//scale it:
		this.offscreen_canvas_ctx.drawImage(this.offscreen_canvas, x, y, enc_width, enc_height, x, y, width, height);
	}
};


XpraWindow.prototype._close_broadway = function() {
	this.broadway_decoder = null;
};


XpraWindow.prototype._close_video = function() {
	this.debug("draw", "close_video: video_source_buffer=", this.video_source_buffer, ", media_source=", this.media_source, ", video=", this.video);
	this.video_source_ready = false;
	if(this.video) {
		if(this.media_source) {
			try {
				if(this.video_source_buffer) {
					this.media_source.removeSourceBuffer(this.video_source_buffer);
				}
				this.media_source.endOfStream();
			} catch(e) {
				this.exc(e, "video media source EOS error");
			}
			this.video_source_buffer = null;
			this.media_source = null;
		}
		this.video.remove();
		this.video = null;
	}
};

XpraWindow.prototype._push_video_buffers = function() {
	this.debug("draw", "_push_video_buffers()");
	const vsb = this.video_source_buffer;
	const vb = this.video_buffers;
	if(!vb || !vsb || !this.video_source_ready) {
		return;
	}
	if(vb.length==0 && this.video_buffers_count==0) {
		return;
	}
	while(vb.length>0 && !vsb.updating) {
		const buffers = vb.splice(0, 20);
		const buffer = [].concat.apply([], buffers);
		vsb.appendBuffer(new Uint8Array(buffer).buffer);
		/*
		 * one at a time:
		const img_data = vb.shift();
		const array = new Uint8Array(img_data);
		vsb.appendBuffer(array.buffer);
		 */
		this.video_buffers_count += buffers.length;
	}
	if(vb.length>0) {
		setTimeout(this._push_video_buffers, 25);
	}
};

XpraWindow.prototype._init_video = function(width, height, coding, profile, level) {
	const me = this;
	this.media_source = MediaSourceUtil.getMediaSource();
	//MediaSourceUtil.addMediaSourceEventDebugListeners(this.media_source, "video");
	//<video> element:
	this.video = document.createElement("video");
	this.video.muted = true;
	this.video.setAttribute('autoplay', true);
	this.video.setAttribute('muted', true);
	this.video.setAttribute('width', width);
	this.video.setAttribute('height', height);
	this.video.style.pointerEvents = "all";
	this.video.style.position = "absolute";
	this.video.style.zIndex = this.div.css("z-index")+1;
	this.video.style.left  = ""+this.leftoffset+"px";
	this.video.style.top = ""+this.topoffset+"px";
	if (this.debug_categories.includes("audio")) {
		MediaSourceUtil.addMediaElementEventDebugListeners(this.video, "video");
		this.video.setAttribute('controls', "controls");
	}
	this.video.addEventListener('error', function() { me.error("video error"); });
	this.video.src = window.URL.createObjectURL(this.media_source);
	//this.video.src = "https://html5-demos.appspot.com/static/test.webm"
	this.video_buffers = [];
	this.video_buffers_count = 0;
	this.video_source_ready = false;

	let codec_string = "";
	if(coding=="h264+mp4" || coding=="mpeg4+mp4") {
		//ie: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'
		codec_string = 'video/mp4; codecs="avc1.' + MediaSourceConstants.H264_PROFILE_CODE[profile] + MediaSourceConstants.H264_LEVEL_CODE[level]+'"';
	}
	else if(coding=="vp8+webm") {
		codec_string = 'video/webm;codecs="vp8"';
	}
	else if(coding=="vp9+webm") {
		codec_string = 'video/webm;codecs="vp9"';
	}
	else {
		throw new Error("invalid encoding: "+coding);
	}
	this.log("video codec string: "+codec_string+" for "+coding+" profile '"+profile+"', level '"+level+"'");
	this.media_source.addEventListener('sourceopen', function() {
		me.log("video media source open");
		const vsb = me.media_source.addSourceBuffer(codec_string);
		vsb.mode = "sequence";
		me.video_source_buffer = vsb;
		if (me.debug_categories.includes("draw")) {
			MediaSourceUtil.addSourceBufferEventDebugListeners(vsb, "video");
		}
		vsb.addEventListener('error', function(e) { me.error("video source buffer error"); });
		vsb.addEventListener('waiting', function() {
			me._push_video_buffers();
		});
		//push any buffers that may have accumulated since we initialized the video element:
		me._push_video_buffers();
		me.video_source_ready = true;
	});
	this.canvas.parentElement.appendChild(this.video);
};

XpraWindow.prototype._non_video_paint = function(coding) {
	if(this.video && this.video.style.zIndex!="-1") {
		this.debug("draw", "bringing canvas above video for ", coding, " paint event");
		//push video under the canvas:
		this.video.style.zIndex = "-1";
		//copy video to canvas:
		const width = parseInt(this.video.getAttribute("width"));
		const height = parseInt(this.video.getAttribute("height"));
		this.offscreen_canvas_ctx.drawImage(this.video, 0, 0, width, height);
	}
};


/**
 * Updates the window image with new pixel data
 * we have received from the server.
 * The image is painted into off-screen canvas.
 */
XpraWindow.prototype.paint = function paint() {
	if (this.client.decode_worker) {
		//no need to synchronize paint packets here
		//the decode worker ensures that we get the packets
		//in the correct order, ready to update the canvas
		XpraWindow.prototype.do_paint.apply(this, arguments);
		return;
	}
	//process all paint request in order using the paint_queue:
	const item = Array.prototype.slice.call(arguments);
	this.paint_queue.push(item);
	this.may_paint_now();
};

/**
 * Pick items from the paint_queue
 * if we're not already in the process of painting something.
 */
XpraWindow.prototype.may_paint_now = function paint() {
	this.debug("draw", "may_paint_now() paint pending=", this.paint_pending, ", paint queue length=", this.paint_queue.length);
	let now = performance.now();
	while ((this.paint_pending==0 || (now-this.paint_pending)>=2000) && this.paint_queue.length>0) {
		this.paint_pending = now;
		const item = this.paint_queue.shift();
		this.do_paint.apply(this, item);
		now = performance.now();
	}
};

const DEFAULT_BOX_COLORS = {
        "png"     : "yellow",
        "h264"    : "blue",
        "vp8"     : "green",
        "rgb24"   : "orange",
        "rgb32"   : "red",
        "jpeg"    : "purple",
        "webp"    : "pink",
        "png/P"   : "indigo",
        "png/L"   : "teal",
        "h265"    : "khaki",
        "vp9"     : "lavender",
        "mpeg4"   : "black",
        "scroll"  : "brown",
        "mpeg1"   : "olive",
        };

XpraWindow.prototype.get_jsmpeg_renderer = function get_jsmpeg_renderer() {
	if (this.jsmpeg_renderer==null) {
		const options = {};
		//webgl is still buggy
		//if (JSMpeg.Renderer.WebGL.IsSupported()) {
		//	this.jsmpeg_renderer = new JSMpeg.Renderer.WebGL(options);
		//}
		//else {
		this.jsmpeg_renderer = new JSMpeg.Renderer.Canvas2D(options);
		//}
	}
	return this.jsmpeg_renderer;
};

XpraWindow.prototype._close_jsmpeg = function _close_jsmpeg() {
	if (this.jsmpeg_renderer!=null) {
		this.jsmpeg_renderer.destroy();
	}
	//decoder doesn't need cleanup?
	this.jsmpeg_decoder = null;
};

XpraWindow.prototype.do_paint = function paint(x, y, width, height, coding, img_data, packet_sequence, rowstride, options, decode_callback) {
	const me = this;

	let enc_width = width;
	let enc_height = height;
	const scaled_size = options["scaled_size"];
	const bitmap = coding.startsWith("bitmap:");
	if (bitmap) {
		coding = coding.split(":")[1];
		this.debug("draw", coding, img_data, " at ", ""+x+","+y, ") focused=", this.focused);
	}
	else {
		this.debug("draw", "do_paint(", img_data.length, " bytes of", coding, " data ", width, "x", height, " at ", x, ",", y, ") focused=", this.focused);
	}
	if(scaled_size) {
		enc_width = scaled_size[0];
		enc_height = scaled_size[1];
	}
	function paint_box(color, px, py, pw, ph) {
		me.offscreen_canvas_ctx.strokeStyle = color;
		me.offscreen_canvas_ctx.lineWidth = 2;
		me.offscreen_canvas_ctx.strokeRect(px, py, pw, ph);
	}

	function painted(skip_box) {
		img_data = null;
		me.paint_pending = 0;
		if (!skip_box && me.debug_categories.includes("draw")) {
			const color = DEFAULT_BOX_COLORS[coding] || "white";
			paint_box(color, x, y, width, height);
		}
		decode_callback();
	}

	function paint_error(e) {
		img_data = null;
		me.error("error painting", coding, e);
		me.paint_pending = 0;
		decode_callback(""+e);
	}

	function paint_bitmap() {
		//the decode worker is giving us a Bitmap object ready to use:
		me.offscreen_canvas_ctx.clearRect(x, y, img_data.width, img_data.height);
		me.offscreen_canvas_ctx.drawImage(img_data, x, y);
		painted();
		//this isn't really needed since we don't use the paint_queue at all
		//when decoding in the worker (bitmaps can only come from the decode worker)
		me.may_paint_now();
	}

	try {
		if (coding=="void") {
			painted(true);
			this.may_paint_now();
		}
		else if (coding=="rgb32" || coding=="rgb24") {
			this._non_video_paint(coding);
			if (bitmap) {
				paint_bitmap();
				return;
			}
			//show("options="+(options).toSource());
			if (options!=null && options["zlib"]>0) {
				//show("decompressing "+img_data.length+" bytes of "+coding+"/zlib");
				img_data = new Zlib.Inflate(img_data).decompress();
			} else if (options!=null && options["lz4"]>0) {
				img_data = lz4.decode(img_data);
			}
			let target_stride = enc_width*4;
			this.debug("draw", "got ", img_data.length, "bytes of", coding, "to paint with stride", rowstride, ", target stride", target_stride);
			if (coding=="rgb24") {
				const uint = new Uint8Array(target_stride*enc_height);
				let i = 0,
					j = 0,
					l = img_data.length;
				if (rowstride==enc_width*3) {
					//faster path, single loop:
					while (i<l) {
						uint[j++] = img_data[i++];
						uint[j++] = img_data[i++];
						uint[j++] = img_data[i++];
						uint[j++] = 255;
					}
				}
				else {
					let psrc = 0,
						pdst = 0;
					for (i=0; i<enc_height; i++) {
						psrc = i*rowstride;
						for (j=0; j<enc_width; j++) {
							uint[pdst++] = img_data[psrc++];
							uint[pdst++] = img_data[psrc++];
							uint[pdst++] = img_data[psrc++];
							uint[pdst++] = 255;
						}
					}
				}
				rowstride = target_stride;
				img_data = uint;
			}
			let img = null;
			if (rowstride>target_stride) {
				img = this.offscreen_canvas_ctx.createImageData(Math.round(rowstride/4), enc_height);
			}
			else {
				img = this.offscreen_canvas_ctx.createImageData(enc_width, enc_height);
			}
			img.data.set(img_data);
			//this.offscreen_canvas_ctx.clearRect(x, y, width, height);
			this.offscreen_canvas_ctx.putImageData(img, x, y, 0, 0, enc_width, enc_height);
			if (enc_width!=width || enc_height!=height) {
				//scale it:
				this.offscreen_canvas_ctx.drawImage(this.offscreen_canvas, x, y, enc_width, enc_height, x, y, width, height);
			}
			painted();
			this.may_paint_now();
		}
		else if (coding=="jpeg" || coding=="png" || coding=="webp") {
			this._non_video_paint(coding);
			if (bitmap) {
				paint_bitmap();
				return;
			}
			const j = new Image();
			j.onload = function () {
				if (j.width==0 || j.height==0) {
					paint_error("invalid image size: "+j.width+"x"+j.height);
				}
				else {
					me.offscreen_canvas_ctx.clearRect(x, y, width, height);
					me.offscreen_canvas_ctx.drawImage(j, x, y, width, height);
					painted();
				}
				me.may_paint_now();
			};
			j.onerror = function () {
				paint_error("failed to load "+coding+" into image tag");
				me.may_paint_now();
			};
			j.src = "data:image/"+coding+";base64," + Utilities.ArrayBufferToBase64(img_data);
		}
		else if (coding=="mpeg1") {
			const frame = options["frame"] || 0;
			if (frame==0 || this.jsmpeg_decoder==null) {
				const mpeg_options = {};
				mpeg_options.streaming = true;
				mpeg_options.decodeFirstFrame = false;
				this.jsmpeg_decoder = new JSMpeg.Decoder.MPEG1Video(mpeg_options);
				//TODO: instead of delegating, we should probably subclass the renderer
				// (but which one! GL or not?):
				const renderer = new Object();
				renderer.render = function render(Y, Cr, Cb) {
					const jsmpeg_renderer = me.get_jsmpeg_renderer();
					jsmpeg_renderer.render(Y, Cr, Cb);
					const canvas = jsmpeg_renderer.canvas;
					me.offscreen_canvas_ctx.drawImage(canvas, x, y, width, height);
					paint_box("olive", x, y, width, height);
				};
				renderer.resize = function resize(newWidth, newHeight) {
					const jsmpeg_renderer = me.get_jsmpeg_renderer();
					jsmpeg_renderer.resize(newWidth, newHeight);
				};
				this.jsmpeg_decoder.connect(renderer);
			}
			this.jsmpeg_decoder.write(frame, img_data);
			const decoded = this.jsmpeg_decoder.decode();
			this.debug("draw", coding, "frame", frame, "data len=", img_data.length, "decoded=", decoded);
			//TODO: only call painted when we have actually painted the frame?
			painted();
		}
		else if (coding=="h264") {
			const frame = options["frame"] || 0;
			if(frame==0) {
				this._close_broadway();
			}
			if(!this.broadway_decoder) {
				this._init_broadway(enc_width, enc_height, width, height);
			}
			this.broadway_paint_location = [x, y];
			// we can pass a buffer full of NALs to decode() directly
			// as long as they are framed properly with the NAL header
			this.broadway_decoder.decode(img_data);
			// broadway decoding is synchronous:
			// (and already painted via the onPictureDecoded callback)
			painted();
		}
		else if (coding=="h264+mp4" || coding=="vp8+webm" || coding=="mpeg4+mp4") {
			const frame = options["frame"] || -1;
			if(frame==0) {
				this._close_video();
			}
			if(!this.video) {
				const profile = options["profile"] || "baseline";
				const level = options["level"] || "3.0";
				this._init_video(width, height, coding, profile, level);
			}
			else {
				//keep it above the div:
				this.video.style.zIndex = this.div.css("z-index")+1;
			}
			if(img_data.length>0) {
				this.debug("draw", "video state=", MediaSourceConstants.READY_STATE[this.video.readyState], ", network state=", MediaSourceConstants.NETWORK_STATE[this.video.networkState]);
				this.debug("draw", "video paused=", this.video.paused, ", video buffers=", this.video_buffers.length);
				this.video_buffers.push(img_data);
				if(this.video.paused) {
					this.video.play();
				}
				this._push_video_buffers();
				//try to throttle input:
				const delay = Math.max(10, 50 * (this.video_buffers.length - 25));
				setTimeout(function() {
					painted();
					me.may_paint_now();
				}, delay);
				//this.debug("draw", "video queue: ", this.video_buffers.length);
			}
		}
		else if (coding=="scroll") {
			this._non_video_paint(coding);
			for(let i=0,j=img_data.length;i<j;++i) {
				const scroll_data = img_data[i];
				this.debug("draw", "scroll", i, ":", scroll_data);
 				const sx = scroll_data[0],
					sy = scroll_data[1],
					sw = scroll_data[2],
					sh = scroll_data[3],
					xdelta = scroll_data[4],
					ydelta = scroll_data[5];
				this.offscreen_canvas_ctx.drawImage(this.draw_canvas, sx, sy, sw, sh, sx+xdelta, sy+ydelta, sw, sh);
				if (this.debug_categories.includes("draw")) {
					paint_box("brown", sx+xdelta, sy+ydelta, sw, sh);
				}
			}
			painted(true);
			this.may_paint_now();
		}
		else {
			paint_error("unsupported encoding");
		}
	}
	catch (e) {
		this.exc(e, "error painting", coding, "sequence no", packet_sequence);
		paint_error(e);
	}
};

/**
 * Close the window and free all resources
 */
XpraWindow.prototype.destroy = function destroy() {
	// remove div
	this._close_jsmpeg();
	this._close_broadway();
	this._close_video();
	this.div.remove();
};
