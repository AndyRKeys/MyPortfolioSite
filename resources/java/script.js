// duration of scroll animation
var scrollDuration = 300;
// paddles
var leftPaddle = document.getElementsByClassName('left-paddle');
var rightPaddle = document.getElementsByClassName('right-paddle');
// get items dimensions
var itemsLength = $('.port-cont').length;
var itemSize = $('.port-cont').outerWidth(true);
// get some relevant size for the paddle triggering point
var paddleMargin = 20;

// get wrapper width
var getMenuWrapperSize = function() {
    return $('.hs-wrap').outerWidth();
}
var menuWrapperSize = getMenuWrapperSize();
// the wrapper is responsive
$(window).on('resize', function() {
    menuWrapperSize = getMenuWrapperSize();
});
// size of the visible part of the menu is equal as the wrapper size
var menuVisibleSize = menuWrapperSize;

// get total width of all menu items
var getMenuSize = function() {
    return itemsLength * itemSize;
};
var menuSize = getMenuSize();
// get how much of menu is invisible
var menuInvisibleSize = menuSize - menuWrapperSize;

// get how much have we scrolled to the left
var getMenuPosition = function() {
    return $('.hs').scrollLeft();
};

// finally, what happens when we are actually scrolling the menu
$('.hs').on('scroll', function() {

    // get how much of menu is invisible
    menuInvisibleSize = menuSize - menuWrapperSize;
    // get how much have we scrolled so far
    var menuPosition = getMenuPosition();

    var menuEndOffset = menuInvisibleSize - paddleMargin;

    // show & hide the paddles
    // depending on scroll position
    if (menuPosition <= paddleMargin) {
        $(leftPaddle).addClass('hidden');
        $(rightPaddle).removeClass('hidden');
    } else if (menuPosition < menuEndOffset) {
        // show both paddles in the middle
        $(leftPaddle).removeClass('hidden');
        $(rightPaddle).removeClass('hidden');
    } else if (menuPosition >= menuEndOffset) {
        $(leftPaddle).removeClass('hidden');
        $(rightPaddle).addClass('hidden');
    }

    // print important values
    // $('#print-wrapper-size span').text(menuWrapperSize);
    // $('#print-menu-size span').text(menuSize);
    // $('#print-menu-invisible-size span').text(menuInvisibleSize);
    // $('#print-menu-position span').text(menuPosition);

});

// scroll to left
$(rightPaddle).on('click', function() {
    $('.hs').animate({ scrollLeft: menuInvisibleSize }, scrollDuration);
});

// scroll to right
$(leftPaddle).on('click', function() {
    $('.hs').animate({ scrollLeft: '0' }, scrollDuration);
});

/*
dynamically set height of elements so scroll bar is hidden
*/
var childDivs = document.getElementsByClassName('hs');

for (var i = 0; i < childDivs.length; i++) {

    var childHeight = getHeight(childDivs[i]);
    var parentHeight = childHeight - 20;
    var parent = childDivs[i].parentNode;

    setHeight(parent, parentHeight);

}

function getHeight(div) {
    return div.offsetHeight;
}

function setHeight(div, height) {
    div.style.height = height + "px";
}

function buildPublicTravelCard(travel) {
    var card = $('<article class="travel-card box draft-card"></article>');
    var media = $('<div class="media"></div>');
    if (travel.mediaUrl) {
        if (travel.mediaType && travel.mediaType.indexOf('video') === 0) {
            media.append('<video controls src="' + travel.mediaUrl + '"></video>');
        } else {
            media.append('<img src="' + travel.mediaUrl + '" alt="Travel snapshot">');
        }
    } else {
        media.append('<img src="./resources/img/placeholder-transparent.png" alt="Travel snapshot">');
    }
    var content = $('<div class="travel-content"></div>');
    content.append('<h3>' + (travel.title || 'Untitled memory') + '</h3>');
    content.append('<p class="meta">' + (travel.location || 'Location not set') + '</p>');
    content.append('<p>' + (travel.notes || 'No notes yet.') + '</p>');
    card.append(media).append(content);
    return card;
}

function loadPublicTravelPosts() {
    if (!window.localStorage) {
        return;
    }
    var travelGrid = $('#travel-grid');
    if (!travelGrid.length) {
        return;
    }
    var saved = localStorage.getItem('travelMemoryDrafts');
    var travelDrafts = [];
    if (saved) {
        try {
            travelDrafts = JSON.parse(saved) || [];
        } catch (e) {
            console.warn('Unable to load travel memories', e);
        }
    }
    if (travelDrafts.length === 0) {
        $('#travel-empty').removeClass('hidden');
        return;
    }
    travelDrafts.forEach(function(travel) {
        travelGrid.append(buildPublicTravelCard(travel));
    });
}

$(document).ready(function() {
    loadPublicTravelPosts();
});